//! Theo dõi thư mục log bằng `notify` (ReadDirectoryChangesW trên Windows).
//!
//! Chỉ chuyển đường dẫn file `.jsonl` bị tạo/sửa sang vòng chính qua kênh; không đọc nội
//! dung. Thư mục chưa tồn tại thì bỏ qua và thử lại ở mỗi lần quét ([`LogWatcher::refresh`]).
//! Không watch được (lỗi hệ điều hành) thì daemon vẫn chạy nhờ quét lại định kỳ.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use notify::event::EventKind;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc::UnboundedSender;

/// Sự kiện này có đáng xét không: tạo/sửa/đổi tên file `.jsonl`.
pub fn is_relevant(kind: &EventKind, path: &Path) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any
    ) && path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
}

pub struct LogWatcher {
    watcher: Option<RecommendedWatcher>,
    dirs: Vec<PathBuf>,
    watched: HashSet<PathBuf>,
}

impl LogWatcher {
    /// Tạo watcher cho `dirs`; sự kiện gửi qua `tx`.
    pub fn new(dirs: Vec<PathBuf>, tx: UnboundedSender<PathBuf>) -> Self {
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            // Chạy trên thread của notify: chỉ lọc và chuyển đường dẫn, không log nội dung.
            let Ok(event) = res else {
                return;
            };
            for path in event.paths {
                if is_relevant(&event.kind, &path) {
                    let _ = tx.send(path);
                }
            }
        });
        let watcher = match watcher {
            Ok(w) => Some(w),
            Err(e) => {
                tracing::warn!(error = %e, "không tạo được watcher, chỉ quét lại định kỳ");
                None
            }
        };
        let mut me = Self {
            watcher,
            dirs,
            watched: HashSet::new(),
        };
        me.refresh();
        me
    }

    /// Watch các thư mục đã xuất hiện mà chưa watch.
    pub fn refresh(&mut self) {
        let Some(watcher) = self.watcher.as_mut() else {
            return;
        };
        for dir in &self.dirs {
            if self.watched.contains(dir) || !dir.is_dir() {
                continue;
            }
            match watcher.watch(dir, RecursiveMode::Recursive) {
                Ok(()) => {
                    tracing::info!(dir = %dir.display(), "đang theo dõi thư mục log");
                    self.watched.insert(dir.clone());
                }
                Err(e) => {
                    tracing::warn!(dir = %dir.display(), error = %e, "không theo dõi được thư mục log");
                }
            }
        }
    }

    /// Số thư mục đang theo dõi.
    pub fn watched_count(&self) -> usize {
        self.watched.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, ModifyKind, RemoveKind};
    use std::time::Duration;

    #[test]
    fn chi_xet_jsonl_tao_hoac_sua() {
        let p = Path::new(r"C:\x\a.jsonl");
        assert!(is_relevant(&EventKind::Create(CreateKind::File), p));
        assert!(is_relevant(&EventKind::Modify(ModifyKind::Any), p));
        assert!(!is_relevant(&EventKind::Remove(RemoveKind::File), p));
        assert!(!is_relevant(&EventKind::Access(AccessKind::Any), p));
        assert!(!is_relevant(
            &EventKind::Modify(ModifyKind::Any),
            Path::new(r"C:\x\a.meta.json")
        ));
    }

    #[tokio::test]
    async fn bao_su_kien_khi_file_doi_va_bo_qua_thu_muc_chua_co() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("projects");
        let missing = dir.path().join("chua-co");
        std::fs::create_dir_all(root.join("p")).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut w = LogWatcher::new(vec![root.clone(), missing.clone()], tx);
        assert_eq!(w.watched_count(), 1);

        let file = root.join("p").join("s.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        let got = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("phải nhận được sự kiện")
            .unwrap();
        assert!(got.ends_with("s.jsonl"), "{got:?}");

        // Thư mục xuất hiện sau: lần refresh kế tiếp bắt đầu theo dõi.
        std::fs::create_dir_all(&missing).unwrap();
        w.refresh();
        assert_eq!(w.watched_count(), 2);
    }
}
