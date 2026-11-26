//! Chạy cả pipeline trên máy: discover → đọc → normalize → **lọc phạm vi ngay** →
//! [`super::prepare`] (che secret, đổi đường dẫn, cắt). Task M1.7.
//!
//! Session ngoài phạm vi bị bỏ ngay sau normalize: chỉ tăng bộ đếm
//! [`CollectStats::out_of_scope`] (để in cho chính người dùng trên máy), không giữ
//! lại `cwd`, nội dung hay metadata nào của nó.
//!
//! Mốc 1 chưa có hàng đợi/offset: mỗi lần đọc lại toàn bộ file từ `Offset(0)`. Server
//! upsert theo `(user, source_id)` và `(session, seq)` nên gửi lại an toàn. M2.3 (đọc
//! tăng dần) và M3.1 (hàng đợi SQLite) sẽ thay phần này.

use std::path::Path;
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};
use tl_adapters::{Adapter, Offset, SourceFile};
use tl_core::redact::Redactor;
use tl_core::session::SessionEnvelope;

use super::prepare::{prepare_session, PrepareOptions};
use super::scope::ScopeFilter;

/// File log không đổi trong khoảng này thì coi là "ổn định" (session đã kết thúc).
pub const STABLE_AFTER: Duration = Duration::from_secs(120);

/// Một session trong phạm vi, đã xử lý xong, sẵn sàng gửi.
#[derive(Debug, Clone)]
pub struct PreparedSession {
    pub envelope: SessionEnvelope,
    /// Project khớp (dùng để in link dashboard).
    pub project_id: String,
    /// Thời điểm hoạt động cuối (turn cuối, hoặc `started_at`).
    pub last_activity: DateTime<Utc>,
}

/// Thống kê một lần quét. Chỉ có số đếm, không có gì định danh session ngoài phạm vi.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CollectStats {
    /// Số file log đã đọc.
    pub files: usize,
    /// Số file không đọc được.
    pub read_errors: usize,
    /// Tổng số bản ghi hỏng/không nhận ra (adapter bỏ qua).
    pub parse_warnings: u64,
    /// Số session trong phạm vi.
    pub in_scope: usize,
    /// Số session bị bỏ vì ngoài phạm vi (không `cwd`, không phải git repo, remote không khớp).
    pub out_of_scope: usize,
}

impl CollectStats {
    pub fn merge(&mut self, other: &CollectStats) {
        self.files += other.files;
        self.read_errors += other.read_errors;
        self.parse_warnings += other.parse_warnings;
        self.in_scope += other.in_scope;
        self.out_of_scope += other.out_of_scope;
    }
}

/// Ngữ cảnh chạy pipeline.
pub struct Pipeline<'a> {
    pub filter: &'a mut ScopeFilter,
    pub redactor: &'a Redactor,
    pub options: &'a PrepareOptions,
    /// Thời điểm "bây giờ", để xét file còn đang được ghi.
    pub now: SystemTime,
}

impl Pipeline<'_> {
    /// Quét mọi file của mọi adapter.
    pub fn collect(&mut self, adapters: &[&dyn Adapter]) -> (Vec<PreparedSession>, CollectStats) {
        let mut out = Vec::new();
        let mut stats = CollectStats::default();
        for adapter in adapters {
            for file in adapter.discover() {
                let (sessions, s) = self.process_file(*adapter, &file);
                out.extend(sessions);
                stats.merge(&s);
            }
        }
        (out, stats)
    }

    /// Đọc, chuẩn hóa, lọc phạm vi và xử lý một file log.
    pub fn process_file(
        &mut self,
        adapter: &dyn Adapter,
        file: &SourceFile,
    ) -> (Vec<PreparedSession>, CollectStats) {
        let mut stats = CollectStats {
            files: 1,
            ..CollectStats::default()
        };
        let events = match adapter.read_incremental(file, Offset(0)) {
            Ok((events, _)) => events,
            Err(e) => {
                // Lỗi chỉ ghi ở mức debug, không kèm nội dung file.
                tracing::debug!(error = %e, "không đọc được file log");
                stats.read_errors = 1;
                return (Vec::new(), stats);
            }
        };
        let active = file
            .modified
            .and_then(|m| self.now.duration_since(m).ok())
            .is_none_or(|age| age < STABLE_AFTER);

        let mut out = Vec::new();
        for ns in adapter.normalize(events) {
            stats.parse_warnings += u64::from(ns.parse_warnings);
            // Chốt chặn quyền riêng tư: lọc ngay sau normalize.
            let Some(scope) = self.filter.scope_of(ns.cwd.as_deref()) else {
                stats.out_of_scope += 1;
                drop(ns);
                continue;
            };
            stats.in_scope += 1;
            let envelope = prepare_session(ns, &scope, self.redactor, self.options, active);
            let last_activity = envelope
                .turns
                .last()
                .map(|t| t.ts)
                .unwrap_or(envelope.session.started_at);
            out.push(PreparedSession {
                envelope,
                project_id: scope.matched.project_id.clone(),
                last_activity,
            });
        }
        (out, stats)
    }
}

/// Dựng [`SourceFile`] cho một đường dẫn người dùng chỉ định (`tl preview <file>`).
pub fn source_file(adapter: &dyn Adapter, path: &Path) -> std::io::Result<SourceFile> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "không phải file",
        ));
    }
    Ok(SourceFile {
        agent: adapter.id(),
        path: path.to_path_buf(),
        size: meta.len(),
        modified: meta.modified().ok(),
    })
}
