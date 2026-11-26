//! Vòng quét dùng chung của `tl sync` và `tl daemon` (M3.2): discover → so với
//! `state.db` ([`classify`]) → đọc + lọc phạm vi + che secret → lọc theo đồng ý → kế
//! hoạch gửi từng file ([`FilePlan`]). Turn phát sinh trong lúc `tl pause` bị bỏ (M3.3).
//!
//! Kế hoạch được trả dần qua callback từng file để daemon xếp hàng theo cụm, không giữ
//! toàn bộ session của mọi file trong RAM cùng lúc.

use std::time::SystemTime;

use crate::consent::ConsentState;
use crate::heartbeat;
use crate::pipeline::collect::{CollectStats, Pipeline};
use crate::state::StateDb;
use crate::sync::incremental::{
    classify, is_active, FilePlan, FileStatus, PlannedSession, SCOPE_META_KEY,
};
use crate::sync::Sources;

/// Tùy chọn một lần quét.
#[derive(Debug, Clone, Copy)]
pub struct ScanOptions {
    /// Gửi cả file còn đang được ghi (`tl sync --include-active`).
    pub include_active: bool,
    /// Bỏ qua tiến độ đã lưu, xem như gửi lại từ đầu (dry-run khi phạm vi đổi).
    pub ignore_state: bool,
    /// Ghi số bản ghi lỗi và phiên bản agent của từng file vào `state.db` (không ghi khi
    /// dry-run).
    pub record_meta: bool,
}

/// Số liệu một lần quét.
#[derive(Debug, Default, Clone)]
pub struct ScanStats {
    pub collect: CollectStats,
    /// File không đổi từ lần gửi trước (không đọc).
    pub unchanged: usize,
    /// File còn đang được ghi (chưa ổn định 2 phút).
    pub waiting: usize,
    /// Session bị bỏ theo lựa chọn khi đồng ý.
    pub skipped_by_consent: usize,
    /// Turn bị bỏ vì phát sinh trong lúc `tl pause`.
    pub dropped_paused: usize,
}

/// Phạm vi gửi đã đổi so với lần trước (server, repo pattern, đồng ý)?
pub fn scope_changed(db: &StateDb, fingerprint: &str) -> rusqlite::Result<bool> {
    Ok(db.meta(SCOPE_META_KEY)?.as_deref() != Some(fingerprint))
}

/// Phạm vi đổi: bỏ batch cũ (có thể thuộc server khác), quên mọi offset, ghi dấu mới.
pub fn reset_scope(db: &mut StateDb, fingerprint: &str) -> rusqlite::Result<()> {
    crate::queue::clear(db)?;
    db.reset_files()?;
    db.set_meta(SCOPE_META_KEY, fingerprint)
}

/// Quét mọi file của mọi adapter, gọi `on_plan` cho mỗi file cần gửi. Lỗi `state.db`
/// (đọc tiến độ, ghi lỗi, hoặc từ `on_plan`) dừng quét và trả `Err`.
pub fn scan(
    db: &mut StateDb,
    sources: &Sources,
    pipeline: &mut Pipeline<'_>,
    consent: Option<&ConsentState>,
    opts: ScanOptions,
    on_plan: &mut dyn FnMut(&mut StateDb, FilePlan) -> rusqlite::Result<()>,
) -> rusqlite::Result<ScanStats> {
    let now: SystemTime = pipeline.now;
    let mut stats = ScanStats::default();
    // Turn phát sinh lúc `tl pause` không bao giờ được gửi.
    let pause_windows = db.pause_windows()?;
    for adapter in sources.adapter_refs() {
        for file in adapter.discover() {
            let prev = if opts.ignore_state {
                None
            } else {
                db.effective_file(&file.path)?
            };
            let reset = match classify(&file, prev.as_ref(), now, opts.include_active) {
                FileStatus::Unchanged => {
                    stats.unchanged += 1;
                    continue;
                }
                FileStatus::Waiting => {
                    stats.waiting += 1;
                    continue;
                }
                FileStatus::Ready { reset } => reset,
            };
            let (sessions, s) = pipeline.process_file(adapter, &file);
            stats.collect.merge(&s);
            if opts.record_meta {
                // Phiên bản agent (chỉ từ session trong phạm vi) để heartbeat báo lên server.
                if let Some(v) = sessions
                    .iter()
                    .filter_map(|p| p.envelope.session.agent_version.as_deref())
                    .next_back()
                {
                    db.set_meta(&heartbeat::agent_version_key(file.agent.as_str()), v)?;
                }
                db.record_parse_errors(
                    &file.path,
                    file.agent.as_str(),
                    s.parse_warnings,
                    s.read_errors > 0,
                )?;
            }
            if s.read_errors > 0 {
                continue; // Không ghi offset: lần sau đọc lại.
            }
            let prev_sessions = if reset { None } else { prev.as_ref() };
            let mut planned = Vec::new();
            for p in sessions {
                // Chỉ gửi session của project đã đồng ý; không backfill thì bỏ session cũ.
                if let Some(state) = consent {
                    if !state.allows_session(&p.project_id, p.last_activity) {
                        stats.skipped_by_consent += 1;
                        continue;
                    }
                }
                let progress = prev_sessions.and_then(|f| f.session(&p.envelope.session.source_id));
                let mut plan = PlannedSession::new(p, progress);
                stats.dropped_paused += plan.drop_paused_turns(&pause_windows);
                planned.push(plan);
            }
            let plan = FilePlan {
                active: is_active(&file, now),
                file,
                reset,
                prev,
                sessions: planned,
            };
            on_plan(db, plan)?;
        }
    }
    Ok(stats)
}
