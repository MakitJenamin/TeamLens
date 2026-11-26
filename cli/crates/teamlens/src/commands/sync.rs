//! `tl sync` — quét log, lọc phạm vi, che secret, cắt rồi gửi lên server.
//!
//! Chạy đúng một lần rồi thoát, cả khi không có `--once` (chạy nền là `tl daemon`, M3.2).
//! M2.3: chỉ gửi phần mới của mỗi file log theo `state.db` ([`crate::sync::incremental`]),
//! và chỉ gửi file đã ổn định (không đổi ≥ 2 phút) trừ khi có `--include-active`.
//! Chưa có hàng đợi (M3.1): gửi lỗi thì lần sau đọc và gửi lại phần chưa gửi.

use std::collections::HashMap;
use std::io::Write;
use std::time::SystemTime;

use clap::Args;
use tl_core::redact::Redactor;

use crate::consent;
use crate::context::AppContext;
use crate::error::AppError;
use crate::pipeline::batch::MAX_BATCH_JSON_BYTES;
use crate::pipeline::collect::{CollectStats, Pipeline};
use crate::pipeline::scope::ScopeFilter;
use crate::state::{state_path, StateDb};
use crate::sync::agent_config::{self, ConfigSource};
use crate::sync::incremental::{
    classify, is_active, scope_fingerprint, FilePlan, FileStatus, PlannedSession, SCOPE_META_KEY,
};
use crate::sync::{connect, consent_gate, dashboard_link, send_all, SendReport, Sources};

/// Số link dashboard in tối đa sau khi gửi.
const MAX_LINKS: usize = 5;

#[derive(Debug, Args)]
pub struct SyncArgs {
    /// Quét và gửi một lần rồi thoát (lệnh này luôn chạy một lần; chạy nền là `tl daemon`, task M3.2)
    #[arg(long)]
    pub once: bool,
    /// Chỉ in thống kê sẽ gửi, không gửi gì
    #[arg(long)]
    pub dry_run: bool,
    /// Gửi cả session còn đang được ghi (file sửa chưa tới 2 phút), dùng khi thử tay
    #[arg(long)]
    pub include_active: bool,
}

pub async fn run(ctx: &AppContext, args: SyncArgs, out: &mut dyn Write) -> Result<(), AppError> {
    run_with(ctx, args, &Sources::from_env(), MAX_BATCH_JSON_BYTES, out).await
}

/// Số file bỏ qua ở lần quét này.
#[derive(Debug, Default)]
struct SkipStats {
    unchanged: usize,
    waiting: usize,
}

fn state_err(ctx: &AppContext) -> impl Fn(rusqlite::Error) -> AppError + '_ {
    move |e| {
        tracing::debug!(error = %e, "lỗi state.db");
        AppError::user(
            format!(
                "Không đọc/ghi được file trạng thái {}.",
                state_path(&ctx.config_path).display()
            ),
            "Kiểm tra quyền ghi thư mục dữ liệu TeamLens; nếu file hỏng có thể xóa state.db (lần sau gửi lại từ đầu, server không ghi trùng).",
        )
    }
}

/// Như [`run`] nhưng nhận nguồn log và ngưỡng batch (để test).
pub async fn run_with(
    ctx: &AppContext,
    args: SyncArgs,
    sources: &Sources,
    max_batch_bytes: usize,
    out: &mut dyn Write,
) -> Result<(), AppError> {
    let _ = args.once; // Luôn một lần.
    if !args.dry_run && !consent_gate::may_send(ctx) {
        return Err(AppError::user(
            "Máy này chưa đồng ý chia sẻ dữ liệu với server hiện tại nên không gửi gì.",
            "Chạy `tl join <link mời>` (link do leader gửi) để xem và đồng ý.",
        ));
    }
    let conn = connect(ctx).await?;
    let local = ctx.load_config()?;
    let server_config = &conn.agent_config.config;
    print_config_source(out, &conn.agent_config.source);
    // Văn bản đồng ý đổi phiên bản hoặc tl quá cũ: không quét, không gửi gì.
    if let Err(block) = agent_config::check_send(&local, server_config, crate::CLI_VERSION) {
        if !args.dry_run {
            return Err(block.to_error());
        }
        let e = block.to_error();
        let _ = writeln!(out, "Lưu ý: {e} Gửi thật sẽ bị dừng.");
    }

    let prepare = agent_config::apply_to_prepare(&sources.prepare, server_config);
    let mut filter = ScopeFilter::new(agent_config::repo_patterns(server_config));
    let consent = consent::current(&local).cloned();

    let mut db = StateDb::open(&state_path(&ctx.config_path))?;
    // Phạm vi gửi đổi (server, repo pattern, đồng ý) → xét lại mọi file từ đầu.
    let fingerprint = scope_fingerprint(&conn.server_url, server_config, consent.as_ref());
    let scope_changed =
        db.meta(SCOPE_META_KEY).map_err(state_err(ctx))?.as_deref() != Some(fingerprint.as_str());
    if scope_changed && !args.dry_run {
        db.reset_files().map_err(state_err(ctx))?;
        db.set_meta(SCOPE_META_KEY, &fingerprint)
            .map_err(state_err(ctx))?;
    }
    let now = SystemTime::now();
    let mut pipeline = Pipeline {
        filter: &mut filter,
        // M2.1: dựng Redactor từ `prepare.server_redaction_patterns` thay cho bộ có sẵn.
        redactor: Redactor::shared(),
        options: &prepare,
        now,
    };
    let mut stats = CollectStats::default();
    let mut skip = SkipStats::default();
    let mut skipped_by_consent = 0usize;
    let mut plans: Vec<FilePlan> = Vec::new();
    for adapter in sources.adapter_refs() {
        for file in adapter.discover() {
            let prev = if scope_changed {
                None // dry-run khi phạm vi đổi: xem như gửi lại từ đầu.
            } else {
                db.file(&file.path).map_err(state_err(ctx))?
            };
            let reset = match classify(&file, prev.as_ref(), now, args.include_active) {
                FileStatus::Unchanged => {
                    skip.unchanged += 1;
                    continue;
                }
                FileStatus::Waiting => {
                    skip.waiting += 1;
                    continue;
                }
                FileStatus::Ready { reset } => reset,
            };
            let (sessions, s) = pipeline.process_file(adapter, &file);
            stats.merge(&s);
            if !args.dry_run {
                db.record_parse_errors(
                    &file.path,
                    file.agent.as_str(),
                    s.parse_warnings,
                    s.read_errors > 0,
                )
                .map_err(state_err(ctx))?;
            }
            if s.read_errors > 0 {
                continue; // Không ghi offset: lần sau đọc lại.
            }
            let prev_sessions = if reset { None } else { prev.as_ref() };
            let mut planned = Vec::new();
            for p in sessions {
                // Chỉ gửi session của project đã đồng ý; không backfill thì bỏ session cũ.
                if let Some(state) = &consent {
                    if !state.allows_session(&p.project_id, p.last_activity) {
                        skipped_by_consent += 1;
                        continue;
                    }
                }
                let progress = prev_sessions.and_then(|f| f.session(&p.envelope.session.source_id));
                planned.push(PlannedSession::new(p, progress));
            }
            plans.push(FilePlan {
                active: is_active(&file, now),
                file,
                reset,
                prev,
                sessions: planned,
            });
        }
    }

    let turns: usize = plans
        .iter()
        .flat_map(|p| &p.sessions)
        .map(PlannedSession::turn_count)
        .sum();
    print_stats(out, &stats, turns);
    print_skips(out, &skip);
    if skipped_by_consent > 0 {
        let _ = writeln!(
            out,
            "Bỏ {skipped_by_consent} session theo lựa chọn khi đồng ý (session cũ khi không gửi lịch sử, hoặc project chưa đồng ý)."
        );
    }
    if consent.is_none() {
        let _ = writeln!(
            out,
            "Máy này chưa đồng ý với server hiện tại: chạy `tl join <link mời>` trước khi gửi thật."
        );
    }

    if args.dry_run {
        let _ = writeln!(out, "Chạy thử (--dry-run): không gửi gì.");
        return Ok(());
    }

    let mut expected: HashMap<String, usize> = HashMap::new();
    let mut project_of: HashMap<String, String> = HashMap::new();
    let mut envelopes = Vec::new();
    for s in plans.iter().flat_map(|p| &p.sessions) {
        let id = s.progress.source_id.clone();
        *expected.entry(id.clone()).or_default() += s.turn_count();
        project_of.insert(id, s.prepared.project_id.clone());
        envelopes.push(s.prepared.envelope.clone());
    }

    if envelopes.is_empty() {
        // Vẫn ghi offset cho file không có gì để gửi (ngoài phạm vi...) để lần sau khỏi đọc.
        commit(&mut db, &plans, &HashMap::new(), &expected, ctx)?;
        let _ = writeln!(out, "Không có session nào mới trong phạm vi để gửi.");
        return Ok(());
    }

    let (report, err) = send_all(&conn.client, envelopes, max_batch_bytes, ctx.poll_unit).await;
    // Chỉ ghi offset của file mà server đã nhận đủ (202) mọi turn đã gửi.
    commit(&mut db, &plans, &report.delivered_turns, &expected, ctx)?;
    match err {
        None => {
            print_report(out, &conn.server_url, &project_of, &report);
            Ok(())
        }
        Some(err) => {
            if report.batches > 0 {
                print_report(out, &conn.server_url, &project_of, &report);
            }
            Err(err)
        }
    }
}

/// Báo khi đang dùng config cache (mất mạng lúc tải).
pub(crate) fn print_config_source(out: &mut dyn Write, source: &ConfigSource) {
    if let ConfigSource::Cache { fetched_at } = source {
        let _ = writeln!(
            out,
            "Không tải được cấu hình từ server, dùng bản đã lưu lúc {} (UTC).",
            fetched_at.format("%Y-%m-%d %H:%M")
        );
    }
}

/// Ghi trạng thái các file đã gửi xong.
fn commit(
    db: &mut StateDb,
    plans: &[FilePlan],
    delivered: &HashMap<String, usize>,
    expected: &HashMap<String, usize>,
    ctx: &AppContext,
) -> Result<(), AppError> {
    for plan in plans {
        if let Some(state) = plan.committed_state(delivered, expected) {
            db.save_file(&plan.file.path, &state)
                .map_err(state_err(ctx))?;
        }
    }
    Ok(())
}

fn print_stats(out: &mut dyn Write, s: &CollectStats, turns: usize) {
    let _ = writeln!(
        out,
        "Đã quét {} file log: {} session trong phạm vi ({} turn), {} session ngoài phạm vi bị bỏ (không gửi gì).",
        s.files, s.in_scope, turns, s.out_of_scope
    );
    if s.read_errors > 0 || s.parse_warnings > 0 {
        let _ = writeln!(
            out,
            "Cảnh báo: {} file không đọc được, {} bản ghi không nhận ra đã bỏ qua.",
            s.read_errors, s.parse_warnings
        );
    }
}

fn print_skips(out: &mut dyn Write, s: &SkipStats) {
    if s.unchanged > 0 {
        let _ = writeln!(
            out,
            "Bỏ qua {} file log không đổi từ lần gửi trước.",
            s.unchanged
        );
    }
    if s.waiting > 0 {
        let _ = writeln!(
            out,
            "{} file log đang được ghi (sửa chưa tới 2 phút): chờ lần sau, hoặc thêm `--include-active` để gửi luôn.",
            s.waiting
        );
    }
}

fn print_report(
    out: &mut dyn Write,
    server_url: &str,
    project_of: &HashMap<String, String>,
    r: &SendReport,
) {
    let turns: u64 = r.accepted.iter().map(|a| a.turns_upserted).sum();
    let _ = writeln!(
        out,
        "Đã gửi {} batch: server nhận {} session ({} turn được thêm/cập nhật), từ chối {}.",
        r.batches,
        r.accepted.len(),
        turns,
        r.rejected.len()
    );
    if r.duplicate_batches > 0 {
        let _ = writeln!(
            out,
            "({} batch server đã nhận từ trước, không ghi lại.)",
            r.duplicate_batches
        );
    }
    for rej in &r.rejected {
        let _ = writeln!(
            out,
            "  ✗ {}: {} ({})",
            rej.source_id, rej.message, rej.error
        );
    }
    let links: Vec<String> = r
        .accepted
        .iter()
        .filter_map(|a| {
            let project = project_of.get(&a.source_id)?;
            Some(dashboard_link(server_url, project, &a.session_id))
        })
        .collect();
    if !links.is_empty() {
        let _ = writeln!(out, "Xem trên dashboard:");
        for link in links.iter().take(MAX_LINKS) {
            let _ = writeln!(out, "  {link}");
        }
        if links.len() > MAX_LINKS {
            let _ = writeln!(out, "  … và {} session khác.", links.len() - MAX_LINKS);
        }
    }
}
