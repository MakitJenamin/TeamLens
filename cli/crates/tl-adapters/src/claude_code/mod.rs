//! Adapter Claude Code.
//!
//! - Task M1-X3 (đọc cả file), M2-Y2 (đọc tăng dần): tìm `%USERPROFILE%\.claude\projects\<cwd-mã-hóa>\<uuid>.jsonl`
//!   (đổi root qua `CLAUDE_CONFIG_DIR`), đọc JSONL tăng dần theo offset.
//! - Task M1-X3, M2-Y3: chuẩn hóa turns, usage đếm một lần theo `message.id`,
//!   transcript subagent thành session con (`parent_source_id`).
