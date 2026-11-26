//! Adapter đọc log gốc của từng AI agent và chuẩn hóa về schema session v1.
//!
//! Mỗi agent một module, cùng implement trait [`Adapter`] (spec mục 5.2):
//!
//! | Module | Agent | Task |
//! | --- | --- | --- |
//! | [`claude_code`] | Claude Code | M1.3, M2.3, M2.4 |
//! | [`codex`] | Codex CLI | M2.5 |
//!
//! Quy tắc chung: bản ghi không nhận ra thì bỏ qua và đếm vào `parse_warnings`,
//! không crash; dòng quá [`MAX_LINE_BYTES`] bị cắt; ghi lại `agent_version` đọc được.

pub mod claude_code;
pub mod codex;

use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

/// Loại agent, định nghĩa ở `tl_core::session` (dùng chung với schema v1).
pub use tl_core::session::{AgentKind, NormalizedSession};

/// Giới hạn độ dài một dòng log (10 MB); dài hơn thì cắt (thường là ảnh base64).
pub const MAX_LINE_BYTES: usize = 10 * 1024 * 1024;

/// Một file log tìm thấy trên máy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFile {
    pub agent: AgentKind,
    pub path: PathBuf,
    /// Kích thước lúc phát hiện (byte).
    pub size: u64,
    /// Thời điểm sửa cuối, dùng để xét "đã ổn định" (2 phút không đổi).
    pub modified: Option<SystemTime>,
}

/// Vị trí đã đọc tới trong file (byte offset), lưu trong `state.db` để đọc tăng dần.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct Offset(pub u64);

/// Một bản ghi thô đọc từ log, chưa chuẩn hóa.
#[derive(Debug, Clone, PartialEq)]
pub struct RawEvent {
    /// Offset bắt đầu của bản ghi trong file.
    pub offset: Offset,
    /// Nội dung đã parse (JSONL: mỗi dòng một giá trị).
    pub value: serde_json::Value,
}

/// Lỗi khi đọc log. Bản ghi lẻ không nhận ra KHÔNG phải lỗi (chỉ đếm cảnh báo).
#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("không đọc được file log {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("file log {path} có định dạng không hỗ trợ: {reason}")]
    UnsupportedFormat { path: PathBuf, reason: String },
}

/// Interface chung của mọi adapter (spec mục 5.2).
pub trait Adapter {
    /// Loại agent mà adapter này xử lý.
    fn id(&self) -> AgentKind;
    /// Tìm các file log của agent trên máy.
    fn discover(&self) -> Vec<SourceFile>;
    /// Đọc tiếp từ `from`, trả về các bản ghi mới và offset kế tiếp.
    fn read_incremental(
        &self,
        f: &SourceFile,
        from: Offset,
    ) -> Result<(Vec<RawEvent>, Offset), ParseError>;
    /// Chuyển bản ghi thô thành session chuẩn hóa.
    fn normalize(&self, events: Vec<RawEvent>) -> Vec<NormalizedSession>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_kind_serializes_snake_case() {
        let json = serde_json::to_string(&AgentKind::ClaudeCode).unwrap();
        assert_eq!(json, "\"claude_code\"");
        assert_eq!(AgentKind::CopilotVscode.as_str(), "copilot_vscode");
        let back: AgentKind = serde_json::from_str("\"codex\"").unwrap();
        assert_eq!(back, AgentKind::Codex);
    }
}
