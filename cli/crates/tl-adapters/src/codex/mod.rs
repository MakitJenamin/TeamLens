//! Adapter Codex (CLI, extension VS Code, Codex Desktop) — task M2.5.
//!
//! - Tìm `<root>\sessions\YYYY\MM\DD\rollout-*.jsonl` và `<root>\archived_sessions\
//!   rollout-*.jsonl`. `root` mặc định là `%USERPROFILE%\.codex`, đổi qua biến môi trường
//!   `CODEX_HOME` (giống chính Codex).
//! - Mỗi file rollout là một session, `source_id = codex:<session_meta.id>`; định dạng và
//!   cách chuẩn hóa ở [`normalize`], diff của `apply_patch` ở [`patch`].
//! - Đọc tăng dần dùng chung [`read_jsonl`] (dòng > 10 MB bị cắt, dòng hỏng đếm cảnh báo).

mod normalize;
mod patch;

use std::path::{Path, PathBuf};

use crate::{
    read_jsonl, Adapter, AgentKind, NormalizedSession, Offset, ParseError, RawEvent, SourceFile,
};

/// Biến môi trường đổi thư mục dữ liệu của Codex.
pub const HOME_ENV: &str = "CODEX_HOME";

/// Độ sâu tối đa khi quét `sessions\` (`YYYY\MM\DD` là 3 cấp).
const MAX_DEPTH: usize = 4;

/// Adapter đọc rollout của Codex.
#[derive(Debug, Clone)]
pub struct CodexAdapter {
    /// Thư mục dữ liệu của Codex (chứa `sessions\`, `archived_sessions\`).
    root: PathBuf,
}

impl CodexAdapter {
    /// Adapter đọc từ thư mục `root` (thư mục chứa `sessions\`); dùng cho test.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Adapter với thư mục mặc định trên máy: `CODEX_HOME` nếu có, không thì
    /// `%USERPROFILE%\.codex` (hoặc `$HOME/.codex`). `None` khi không xác định được home.
    pub fn from_env() -> Option<Self> {
        let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty());
        let root = match var(HOME_ENV) {
            Some(dir) => PathBuf::from(dir),
            None => PathBuf::from(var("USERPROFILE").or_else(|| var("HOME"))?).join(".codex"),
        };
        Some(Self::new(root))
    }

    /// Thư mục dữ liệu đang dùng.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `true` nếu tên file có dạng rollout của Codex (`rollout-*.jsonl`).
    pub fn is_rollout_file(path: &Path) -> bool {
        path.extension().is_some_and(|e| e == "jsonl")
            && path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("rollout-"))
    }
}

impl Adapter for CodexAdapter {
    fn id(&self) -> AgentKind {
        AgentKind::Codex
    }

    /// Liệt kê rollout trong `sessions\` (tới [`MAX_DEPTH`] cấp) và `archived_sessions\`,
    /// sắp theo đường dẫn. Thư mục không có hoặc không đọc được thì bỏ qua.
    fn discover(&self) -> Vec<SourceFile> {
        let mut files = Vec::new();
        collect(&self.root.join("sessions"), MAX_DEPTH, &mut files);
        collect(&self.root.join("archived_sessions"), 1, &mut files);
        files.sort_by(|a, b| a.path.cmp(&b.path));
        files
    }

    fn read_incremental(
        &self,
        f: &SourceFile,
        from: Offset,
    ) -> Result<(Vec<RawEvent>, Offset), ParseError> {
        read_jsonl(&f.path, from)
    }

    /// Chuẩn hóa các bản ghi của một file rollout (tối đa một session).
    ///
    /// Kết quả là dữ liệu thô trong RAM, chưa lọc phạm vi/che/cắt/đổi đường dẫn
    /// (xem hợp đồng ở [`NormalizedSession`]).
    fn normalize(&self, events: Vec<RawEvent>) -> Vec<NormalizedSession> {
        normalize::normalize(events)
    }
}

fn collect(dir: &Path, depth: usize, out: &mut Vec<SourceFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            if depth > 1 {
                collect(&path, depth - 1, out);
            }
            continue;
        }
        if !CodexAdapter::is_rollout_file(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_file() {
            out.push(SourceFile {
                agent: AgentKind::Codex,
                path,
                size: meta.len(),
                modified: meta.modified().ok(),
            });
        }
    }
}

#[cfg(test)]
mod tests;
