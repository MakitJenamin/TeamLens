//! Chuyển các dòng JSONL của Claude Code thành [`NormalizedSession`] (task M1.3).
//!
//! Định dạng log là nội bộ của Claude Code (không có tài liệu chính thức), kiểm chứng
//! trên các bản 2.1.219 → 2.1.332. Các điểm chính:
//!
//! - Mỗi dòng có `type`. Chỉ `user` và `assistant` mang hội thoại; các loại còn lại
//!   ([`META_TYPES`]: `summary`, `file-history-snapshot`, `attachment`, `system`,
//!   `api-request*`...) bị bỏ có chủ đích, không đếm cảnh báo. `type` lạ hoặc thiếu
//!   → bỏ và đếm `parse_warnings`.
//! - Dòng `assistant`: mỗi content block thường nằm trên một dòng riêng nhưng cùng
//!   `message.id`, và `usage` bị lặp lại trên từng dòng → chỉ gắn `usage` vào turn đầu
//!   tiên sinh ra từ mỗi `message.id`.
//! - `thinking`/`redacted_thinking`: schema v1 chưa có `kind` tương ứng nên bỏ qua.
//!   Message `model = "<synthetic>"` (do chính Claude Code tự chèn, không phải model
//!   trả lời) cũng bỏ qua.
//! - Dòng `user`: `isMeta = true` (nội dung skill, caveat lệnh local, ảnh tự chèn...) bỏ
//!   qua; block `tool_result` thành turn `tool_result`; text còn lại thành `prompt`.
//!   `origin.kind` khác `human` (vd. `task-notification`) → `role = system`.
//! - `[Request interrupted by user]` (và biến thể `... for tool use`) không thành
//!   prompt mà đánh dấu `interrupted = true` cho turn assistant gần nhất trước nó.
//! - Dòng `isSidechain = true` (transcript subagent cũ nằm chung file) bỏ qua; subagent
//!   thành session con ở task M2.4.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use tl_core::session::{
    AgentKind, Attachment, AttachmentKind, NormalizedSession, Output, PermissionMode, Role,
    Session, Tool, ToolStatus, Turn, TurnKind, Usage,
};

use super::diff;
use crate::RawEvent;

/// Các `type` dòng không mang hội thoại, bỏ qua có chủ đích (không tính cảnh báo).
pub(crate) const META_TYPES: &[&str] = &[
    "summary",
    "system",
    "attachment",
    "file-history-snapshot",
    "file-history-delta",
    "queue-operation",
    "last-prompt",
    "ai-title",
    "custom-title",
    "agent-name",
    "mode",
    "permission-mode",
    "session-owner",
    "atis-latch",
    "isolation-latch",
    "api-request",
    "api-request-blob",
    "api-request-shape",
    "tools-used",
    "pr-link",
    "cost-state",
    // Trỏ sang file session tiếp nối (`continuedInSessionId`); chưa dùng ở M1.3.
    "continued-in",
];

/// Tiền tố của tin nhắn Claude Code chèn khi người dùng ngắt lượt.
const INTERRUPT_PREFIX: &str = "[Request interrupted by user";

/// Text do Claude Code chèn quanh lệnh local (`/clear`, `!cmd`...), không phải prompt.
const LOCAL_COMMAND_PREFIXES: &[&str] = &[
    "<local-command-caveat>",
    "<local-command-stdout>",
    "<local-command-stderr>",
];

/// Chuyển các bản ghi (thường là cả một file) thành các session, nhóm theo `sessionId`
/// theo thứ tự xuất hiện. Session không có turn nào bị bỏ.
pub(crate) fn normalize(events: Vec<RawEvent>) -> Vec<NormalizedSession> {
    let mut sessions: Vec<SessionBuilder> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    // Cảnh báo của dòng chưa biết thuộc session nào (trước dòng có `sessionId` đầu tiên).
    let mut orphan_warnings = 0u32;
    let mut current: Option<usize> = None;

    for event in events {
        let value = &event.value;
        let session_id = value.get("sessionId").and_then(Value::as_str);
        if let Some(id) = session_id {
            let i = *index.entry(id.to_owned()).or_insert_with(|| {
                sessions.push(SessionBuilder::new(id));
                sessions.len() - 1
            });
            current = Some(i);
        }
        let outcome = classify(value);
        match (outcome, current) {
            (Line::Conversation, Some(i)) if session_id.is_some() => sessions[i].push(value),
            (Line::Ignored, _) => {}
            (_, Some(i)) => sessions[i].warnings += 1,
            (_, None) => orphan_warnings += 1,
        }
    }

    if let Some(first) = sessions.first_mut() {
        first.warnings += orphan_warnings;
    }
    sessions
        .into_iter()
        .filter_map(SessionBuilder::finish)
        .collect()
}

enum Line {
    Conversation,
    Ignored,
    Unrecognized,
}

fn classify(value: &Value) -> Line {
    match value.get("type").and_then(Value::as_str) {
        Some("user" | "assistant") => {
            if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                // Transcript subagent kiểu cũ: để task M2.4.
                Line::Ignored
            } else {
                Line::Conversation
            }
        }
        Some(t) if META_TYPES.contains(&t) => Line::Ignored,
        _ => Line::Unrecognized,
    }
}

/// Tích lũy dữ liệu của một session trong lúc duyệt các dòng.
struct SessionBuilder {
    raw_id: String,
    cwd: Option<PathBuf>,
    version: Option<String>,
    /// `Some(..)` sau dòng hội thoại đầu tiên (nhánh lúc bắt đầu, có thể là `None`).
    branch: Option<Option<String>>,
    started_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
    permission_mode: Option<PermissionMode>,
    turns: Vec<Turn>,
    /// `tool_use.id` → vị trí turn `tool_call` trong `turns`.
    tool_calls: HashMap<String, usize>,
    /// `message.id` đã gắn `usage`.
    usage_counted: HashSet<String>,
    warnings: u32,
}

impl SessionBuilder {
    fn new(raw_id: &str) -> Self {
        Self {
            raw_id: raw_id.to_owned(),
            cwd: None,
            version: None,
            branch: None,
            started_at: None,
            ended_at: None,
            permission_mode: None,
            turns: Vec::new(),
            tool_calls: HashMap::new(),
            usage_counted: HashSet::new(),
            warnings: 0,
        }
    }

    /// Xử lý một dòng `user`/`assistant`.
    fn push(&mut self, line: &Value) {
        let ts = line
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.with_timezone(&Utc));
        let (Some(ts), Some(message)) = (ts, line.get("message").filter(|m| m.is_object())) else {
            self.warnings += 1;
            return;
        };
        self.started_at = Some(self.started_at.map_or(ts, |s| s.min(ts)));
        self.ended_at = Some(self.ended_at.map_or(ts, |e| e.max(ts)));
        if self.cwd.is_none() {
            self.cwd = non_empty_str(line, "cwd").map(PathBuf::from);
        }
        if self.version.is_none() {
            self.version = non_empty_str(line, "version").map(|v| v.chars().take(64).collect());
        }
        if self.branch.is_none() {
            // `HEAD` là detached HEAD; schema yêu cầu `null`.
            self.branch = Some(
                non_empty_str(line, "gitBranch")
                    .filter(|b| *b != "HEAD")
                    .map(str::to_owned),
            );
        }

        if line.get("type").and_then(Value::as_str) == Some("assistant") {
            self.push_assistant(message, ts);
        } else {
            self.push_user(line, message, ts);
        }
    }

    fn push_assistant(&mut self, message: &Value, ts: DateTime<Utc>) {
        let model = message.get("model").and_then(Value::as_str);
        if model == Some("<synthetic>") {
            return;
        }
        let first_new = self.turns.len();
        match message.get("content") {
            Some(Value::String(text)) => self.push_reply(text, ts),
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(text) = block.get("text").and_then(Value::as_str) {
                                self.push_reply(text, ts);
                            }
                        }
                        Some("tool_use") => self.push_tool_call(block, ts),
                        Some("thinking" | "redacted_thinking") => {}
                        _ => self.warnings += 1,
                    }
                }
            }
            _ => self.warnings += 1,
        }

        for turn in &mut self.turns[first_new..] {
            turn.model = Some(model.map(str::to_owned));
            // Claude Code không ghi mức suy luận theo kiểu so sánh được (RULES.md mục 4).
            turn.reasoning_effort = Some(None);
        }
        // Usage lặp lại trên mọi dòng cùng `message.id`: chỉ gắn một lần, vào turn đầu
        // tiên sinh ra từ message đó. Dòng không sinh turn nào (chỉ có thinking) thì để
        // dòng sau của cùng message nhận.
        if first_new < self.turns.len() {
            if let Some(usage) = message.get("usage").and_then(parse_usage) {
                let id = message.get("id").and_then(Value::as_str);
                let fresh = match id {
                    Some(id) => self.usage_counted.insert(id.to_owned()),
                    None => true,
                };
                if fresh {
                    self.turns[first_new].usage = Some(usage);
                }
            }
        }
    }

    fn push_reply(&mut self, text: &str, ts: DateTime<Utc>) {
        if text.trim().is_empty() {
            return;
        }
        let mut turn = Turn::new(0, Role::Assistant, TurnKind::Reply, ts);
        turn.text = Some(text.to_owned());
        self.turns.push(turn);
    }

    fn push_tool_call(&mut self, block: &Value, ts: DateTime<Utc>) {
        let name = block.get("name").and_then(Value::as_str).unwrap_or("");
        if name.is_empty() {
            self.warnings += 1;
            return;
        }
        let mut turn = Turn::new(0, Role::Assistant, TurnKind::ToolCall, ts);
        turn.tool = Some(Tool {
            name: name.to_owned(),
            input: block.get("input").and_then(Value::as_object).cloned(),
            status: None,
        });
        if let Some(id) = block.get("id").and_then(Value::as_str) {
            self.tool_calls.insert(id.to_owned(), self.turns.len());
        }
        self.turns.push(turn);
    }

    fn push_user(&mut self, line: &Value, message: &Value, ts: DateTime<Utc>) {
        if line.get("isMeta").and_then(Value::as_bool) == Some(true) {
            return;
        }
        if self.permission_mode.is_none() {
            self.permission_mode = line
                .get("permissionMode")
                .and_then(Value::as_str)
                .map(permission_mode);
        }
        let role = match line.pointer("/origin/kind").and_then(Value::as_str) {
            Some(kind) if kind != "human" => Role::System,
            _ => Role::User,
        };

        let mut texts: Vec<&str> = Vec::new();
        let mut images = 0u32;
        match message.get("content") {
            Some(Value::String(text)) => texts.push(text),
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(Value::as_str) {
                                texts.push(t);
                            }
                        }
                        Some("image") => images += 1,
                        Some("tool_result") => {
                            self.push_tool_result(block, line.get("toolUseResult"), ts)
                        }
                        _ => self.warnings += 1,
                    }
                }
            }
            _ => self.warnings += 1,
        }

        let mut prompt: Vec<&str> = Vec::new();
        for text in texts {
            let trimmed = text.trim();
            if trimmed.starts_with(INTERRUPT_PREFIX) {
                self.mark_interrupted();
            } else if !trimmed.is_empty()
                && !LOCAL_COMMAND_PREFIXES
                    .iter()
                    .any(|p| trimmed.starts_with(p))
            {
                prompt.push(text);
            }
        }
        if prompt.is_empty() && images == 0 {
            return;
        }
        let mut turn = Turn::new(0, role, TurnKind::Prompt, ts);
        if !prompt.is_empty() {
            turn.text = Some(prompt.join("\n"));
        }
        turn.attachments = image_attachments(images);
        self.turns.push(turn);
    }

    fn push_tool_result(
        &mut self,
        block: &Value,
        tool_use_result: Option<&Value>,
        ts: DateTime<Utc>,
    ) {
        let call = block
            .get("tool_use_id")
            .and_then(Value::as_str)
            .and_then(|id| self.tool_calls.get(id).copied());
        let status = if block.get("is_error").and_then(Value::as_bool) == Some(true) {
            ToolStatus::Error
        } else {
            ToolStatus::Ok
        };
        let call_tool = call.and_then(|i| self.turns[i].tool.as_ref());
        let name = call_tool.map_or_else(|| "unknown".to_owned(), |t| t.name.clone());

        let mut images = 0u32;
        let text = match block.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => {
                let mut texts = Vec::new();
                for part in parts {
                    match part.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            texts.push(part.get("text").and_then(Value::as_str).unwrap_or(""))
                        }
                        Some("image") => images += 1,
                        _ => {}
                    }
                }
                texts.join("\n")
            }
            _ => String::new(),
        };

        // Diff chỉ có khi tool chạy thành công.
        let diff = if status == ToolStatus::Ok {
            tool_use_result
                .and_then(diff::from_tool_result)
                .or_else(|| {
                    let tool = call_tool?;
                    diff::from_tool_input(&tool.name, tool.input.as_ref()?)
                })
        } else {
            None
        };

        let mut turn = Turn::new(0, Role::User, TurnKind::ToolResult, ts);
        turn.tool = Some(Tool {
            name,
            input: None,
            status: Some(status),
        });
        turn.output = Some(Output {
            text,
            truncated: false,
            original_bytes: None,
        });
        turn.attachments = image_attachments(images);

        match call {
            Some(i) => {
                let call_turn = &mut self.turns[i];
                if let Some(tool) = call_turn.tool.as_mut() {
                    tool.status = Some(status);
                }
                if diff.is_some() {
                    call_turn.diff = diff;
                }
            }
            // Không thấy tool_call tương ứng (vd. đọc giữa file): gắn diff vào chính kết quả.
            None => turn.diff = diff,
        }
        self.turns.push(turn);
    }

    fn mark_interrupted(&mut self) {
        if let Some(turn) = self
            .turns
            .iter_mut()
            .rev()
            .find(|t| t.role == Role::Assistant)
        {
            turn.interrupted = Some(true);
        }
    }

    fn finish(self) -> Option<NormalizedSession> {
        let started_at = self.started_at?;
        if self.turns.is_empty() {
            return None;
        }
        let mut turns = self.turns;
        for (seq, turn) in turns.iter_mut().enumerate() {
            turn.seq = u32::try_from(seq).unwrap_or(u32::MAX);
        }
        Some(NormalizedSession {
            cwd: self.cwd,
            session: Session {
                source_id: AgentKind::ClaudeCode.source_id(&self.raw_id),
                agent: AgentKind::ClaudeCode,
                agent_version: self.version,
                repo_remote: String::new(),
                branch: self.branch.flatten(),
                cwd_relative: None,
                started_at,
                ended_at: self.ended_at,
                parent_source_id: None,
                permission_mode: self.permission_mode,
                instruction_files: None,
            },
            turns,
            parse_warnings: self.warnings,
        })
    }
}

fn non_empty_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn image_attachments(count: u32) -> Vec<Attachment> {
    if count == 0 {
        return Vec::new();
    }
    vec![Attachment {
        kind: AttachmentKind::Image,
        count,
    }]
}

/// `permissionMode` của Claude Code → enum schema. `auto`, `dontAsk` và giá trị lạ
/// không tương ứng mức nào của schema nên thành `unknown`.
pub(crate) fn permission_mode(raw: &str) -> PermissionMode {
    match raw {
        "default" => PermissionMode::Default,
        "acceptEdits" => PermissionMode::AcceptEdits,
        "plan" => PermissionMode::Plan,
        "bypassPermissions" => PermissionMode::Bypass,
        _ => PermissionMode::Unknown,
    }
}

fn parse_usage(u: &Value) -> Option<Usage> {
    let u: &Map<String, Value> = u.as_object()?;
    let num = |k: &str| u.get(k).and_then(Value::as_u64);
    Some(Usage {
        input: num("input_tokens")?,
        output: num("output_tokens")?,
        cache_read: num("cache_read_input_tokens"),
        cache_write: num("cache_creation_input_tokens"),
        estimated: None,
    })
}
