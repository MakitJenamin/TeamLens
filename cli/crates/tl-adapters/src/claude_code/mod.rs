//! Adapter Claude Code.
//!
//! - Task M1.3 (bản này): tìm `<root>\projects\<cwd-mã-hóa>\<uuid>.jsonl`, đọc cả file,
//!   chuẩn hóa prompt/reply/tool_call/tool_result/diff, `usage` đếm một lần theo
//!   `message.id`, `permission_mode`, `interrupted` (chi tiết ở [`normalize`]).
//!   `root` mặc định là `%USERPROFILE%\.claude`, đổi qua biến môi trường
//!   `CLAUDE_CONFIG_DIR`.
//! - Task M2.3: đọc tăng dần theo offset lưu trong `state.db` (chữ ký
//!   [`Adapter::read_incremental`] đã hỗ trợ sẵn `from`).
//! - Task M2.4: transcript subagent (`<uuid>\subagents\agent-<agentId>.jsonl`) thành
//!   session con `claude_code:<sessionId>:<agentId>` có `parent_source_id`; compaction
//!   (`isCompactSummary`) thành turn `compaction`; `permission_mode` lấy chế độ thoáng
//!   nhất trong session (chi tiết ở [`normalize`]).

mod diff;
mod normalize;

use std::path::{Path, PathBuf};

use crate::{
    read_jsonl, Adapter, AgentKind, NormalizedSession, Offset, ParseError, RawEvent, SourceFile,
};

/// Biến môi trường đổi thư mục cấu hình của Claude Code.
pub const CONFIG_DIR_ENV: &str = "CLAUDE_CONFIG_DIR";

/// Adapter đọc transcript của Claude Code.
#[derive(Debug, Clone)]
pub struct ClaudeCodeAdapter {
    /// Thư mục cấu hình (chứa `projects\`).
    root: PathBuf,
}

impl ClaudeCodeAdapter {
    /// Adapter đọc từ thư mục cấu hình `root` (thư mục chứa `projects\`); dùng cho test.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Adapter với thư mục mặc định trên máy: `CLAUDE_CONFIG_DIR` nếu có, không thì
    /// `%USERPROFILE%\.claude` (hoặc `$HOME/.claude`). `None` khi không xác định được
    /// thư mục home.
    pub fn from_env() -> Option<Self> {
        let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty());
        let root = match var(CONFIG_DIR_ENV) {
            Some(dir) => PathBuf::from(dir),
            None => PathBuf::from(var("USERPROFILE").or_else(|| var("HOME"))?).join(".claude"),
        };
        Some(Self::new(root))
    }

    /// Thư mục cấu hình đang dùng.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Thư mục chứa transcript: `<root>\projects`.
    pub fn projects_dir(&self) -> PathBuf {
        self.root.join("projects")
    }
}

impl Adapter for ClaudeCodeAdapter {
    fn id(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }

    fn watch_dirs(&self) -> Vec<PathBuf> {
        vec![self.projects_dir()]
    }

    /// Liệt kê `<root>\projects\*\*.jsonl` (session gốc) và
    /// `<root>\projects\*\<uuid>\subagents\agent-*.jsonl` (transcript subagent), sắp theo
    /// đường dẫn. Thư mục không tồn tại hoặc không đọc được thì trả về rỗng (máy chưa
    /// dùng Claude Code). File cạnh transcript subagent (`*.meta.json`...) không đọc.
    fn discover(&self) -> Vec<SourceFile> {
        let mut files = Vec::new();
        let Ok(projects) = std::fs::read_dir(self.projects_dir()) else {
            return files;
        };
        for project in projects.flatten() {
            if !project.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(project.path()) else {
                continue;
            };
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|t| t.is_dir()) {
                    push_jsonl_files(&entry.path().join("subagents"), "agent-", &mut files);
                }
            }
            push_jsonl_files(&project.path(), "", &mut files);
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        files
    }

    /// Đọc JSONL từ `from` (M1.3 luôn gọi với `Offset(0)` để đọc cả file).
    fn read_incremental(
        &self,
        f: &SourceFile,
        from: Offset,
    ) -> Result<(Vec<RawEvent>, Offset), ParseError> {
        read_jsonl(&f.path, from)
    }

    /// Chuẩn hóa các bản ghi; mỗi `sessionId` một [`NormalizedSession`].
    ///
    /// Kết quả là dữ liệu thô trong RAM, chưa lọc phạm vi/che/cắt/đổi đường dẫn
    /// (xem hợp đồng ở [`NormalizedSession`]).
    fn normalize(&self, events: Vec<RawEvent>) -> Vec<NormalizedSession> {
        normalize::normalize(events)
    }
}

/// Thêm các file `<prefix>*.jsonl` (đúng một cấp) trong `dir` vào `files`. Thư mục không
/// tồn tại thì bỏ qua.
fn push_jsonl_files(dir: &Path, prefix: &str, files: &mut Vec<SourceFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "jsonl")
            || !entry.file_name().to_string_lossy().starts_with(prefix)
        {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        files.push(SourceFile {
            agent: AgentKind::ClaudeCode,
            path,
            size: meta.len(),
            modified: meta.modified().ok(),
        });
    }
}

#[cfg(test)]
mod tests;
