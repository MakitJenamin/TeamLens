//! Adapter Claude Code.
//!
//! - Task A2: tìm `%USERPROFILE%\.claude\projects\<cwd-mã-hóa>\<uuid>.jsonl`
//!   (đổi root qua `CLAUDE_CONFIG_DIR`), đọc JSONL tăng dần theo offset.
//! - Task A3: chuẩn hóa turns, usage đếm một lần theo `message.id`,
//!   transcript subagent thành session con (`parent_source_id`).
