//! Chuyển rollout JSONL của Codex thành [`NormalizedSession`] (task M2.5).
//!
//! Định dạng là nội bộ của Codex (không có tài liệu chính thức), kiểm chứng trên 35 file
//! thật của các bản 0.130 → 0.146 (CLI, VS Code, Codex Desktop). Mỗi dòng là
//! `{ timestamp, type, payload }`:
//!
//! - `session_meta`: `id`, `cwd`, `cli_version`, `git.branch`, `forked_from_id`, `source`.
//!   Mỗi file là **một** session, id lấy từ `session_meta` đầu tiên. Dòng `session_meta`
//!   cùng id lặp lại (bản 0.130 ghi lại mỗi lượt, hoặc khi resume) bị bỏ qua.
//! - **Fork** (sửa tin nhắn cũ / "fork từ đây"): file mới mở đầu bằng `session_meta` của
//!   chính nó (`forked_from_id`), rồi **chép nguyên** lịch sử session cha (kể cả các dòng
//!   `session_meta` của cha), dấu thời gian bị ghi lại thành lúc chép. Phần chép đó đã
//!   nằm trong file của session cha, gửi lại sẽ đếm token/turn hai lần, nên bỏ: sau một
//!   `session_meta` khác id, mọi dòng bị bỏ cho tới lượt (`task_started`/`turn_context`)
//!   đầu tiên có `turn_id` (UUIDv7) tạo sau id của session (cũng là UUIDv7). Kiểm chứng
//!   trên 5 file fork: phần chép luôn là lượt cũ, phần mới luôn là lượt mới.
//! - Session con (subagent, `source.subagent.thread_spawn.parent_thread_id`) có
//!   `parent_source_id = codex:<id cha>`. Máy dùng để kiểm chứng chưa có file nào như
//!   vậy, nên chỉ có unit test.
//! - `turn_context` (mỗi lượt): `model`, `effort` (→ `reasoning_effort` của các turn
//!   assistant sau nó), `approval_policy` + `sandbox_policy` + `collaboration_mode` (→
//!   `permission_mode`, lấy chế độ thoáng nhất từng dùng như adapter Claude Code).
//! - Prompt lấy từ `event_msg`/`user_message` (đúng chữ người dùng gõ); bản 0.172 bỏ event
//!   này nên lấy thêm từ `event_msg`/`item_completed` có `item.type = UserMessage` (cùng
//!   `turn_id` + cùng chữ thì chỉ tính một lần). Các
//!   `response_item` `message` role `user`/`developer` bị bỏ vì vừa lặp lại prompt, vừa
//!   chứa nội dung Codex tự chèn (`<environment_context>`, `# AGENTS.md instructions`,
//!   `<permissions instructions>`, `<turn_aborted>`...). Tiền tố `# Context from my IDE
//!   setup` của extension VS Code bị cắt, chỉ giữ phần sau `## My request for Codex:`.
//! - Câu trả lời lấy từ `response_item`/`message` role `assistant` (`event_msg`/
//!   `agent_message` là bản lặp cho giao diện). `reasoning` (mã hóa, `summary` thường rỗng)
//!   bỏ qua như `thinking` của Claude Code.
//! - Tool: `function_call` (`shell_command`, `update_plan`, MCP...: `arguments` là chuỗi
//!   JSON), `custom_tool_call` (`apply_patch`, `exec`: `input` là chuỗi), `local_shell_call`,
//!   `web_search_call`, `tool_search_call`; kết quả là `*_output` cùng `call_id`. Trạng
//!   thái lỗi khi `Exit code` khác 0, bị người dùng từ chối, hoặc `patch_apply_end.success
//!   = false`. Diff của `apply_patch` xem [`super::patch`].
//! - `token_count`: `info.total_token_usage` là số **cộng dồn** cả session,
//!   `info.last_token_usage` là của lần gọi model vừa xong. Codex hay ghi lặp cùng một
//!   event (total không đổi) → chỉ cộng `last` khi `total` khác lần trước. Tổng các `last`
//!   đã khử lặp bằng đúng `total` cuối trên cả 30 file thật có token. `input_tokens` của
//!   OpenAI **gồm** `cached_input_tokens`, nên `usage.input = input - cached`,
//!   `usage.cache_read = cached` (cùng nghĩa với Claude Code). Usage gắn vào turn assistant
//!   đầu tiên sinh ra kể từ `token_count` trước; lần gọi không sinh turn nào (chỉ
//!   reasoning) cộng vào turn assistant gần nhất.
//! - `event_msg`/`turn_aborted` → `interrupted = true` cho turn assistant cuối của lượt
//!   (không có thì cho chính prompt của lượt đó).
//! - `compacted` → turn `compaction` (role `system`), text là `message` nếu có.
//! - Bản ghi `type` lạ, `response_item` lạ, dòng hỏng → `parse_warnings`. Các `event_msg`
//!   khác (UI, lặp lại `response_item`), `world_state`, và `token_usage_record` /
//!   `additional_tools` của bản 0.172 bỏ có chủ đích.
//! - `instruction_files` không thuộc adapter: pipeline điền ở bước `prepare` từ gốc repo
//!   (AGENTS.md Codex tự chèn vào prompt cũng chính là file đó).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use tl_core::session::{
    AgentKind, Attachment, AttachmentKind, NormalizedSession, Output, PermissionMode, Role,
    Session, Tool, ToolStatus, Turn, TurnKind, Usage,
};

use super::patch;
use crate::RawEvent;

/// Tên tool sửa file của Codex.
const APPLY_PATCH: &str = "apply_patch";

/// Dấu mở đầu prompt của extension VS Code (kèm danh sách tab đang mở).
const IDE_CONTEXT_PREFIX: &str = "# Context from my IDE setup:";
/// Phần prompt thật nằm sau dòng này.
const IDE_REQUEST_MARKER: &str = "## My request for Codex:";

/// Tiền tố output của tool khi bị từ chối/thất bại mà không có `Exit code`.
const ERROR_OUTPUT_PREFIXES: &[&str] = &[
    "exec command rejected",
    "apply_patch verification failed",
    "patch rejected",
    "Script failed",
    "aborted",
];

/// Chuẩn hóa các bản ghi của **một** file rollout. Không có `session_meta` (file hỏng
/// đầu) hoặc không có turn nào thì trả về rỗng.
pub(crate) fn normalize(events: Vec<RawEvent>) -> Vec<NormalizedSession> {
    let mut builder: Option<SessionBuilder> = None;
    let mut orphan_warnings = 0u32;
    for event in events {
        let value = &event.value;
        match builder.as_mut() {
            Some(b) => b.push(value),
            None => match SessionBuilder::from_meta(value) {
                Some(mut b) => {
                    b.warnings += orphan_warnings;
                    builder = Some(b);
                }
                None => orphan_warnings += 1,
            },
        }
    }
    builder
        .and_then(SessionBuilder::finish)
        .into_iter()
        .collect()
}

struct SessionBuilder {
    raw_id: String,
    /// Mốc thời gian (ms) trong id UUIDv7 của session, để nhận ra lượt mới sau fork.
    id_time: Option<u64>,
    cwd: Option<PathBuf>,
    version: Option<String>,
    branch: Option<String>,
    parent: Option<String>,
    started_at: DateTime<Utc>,
    ended_at: DateTime<Utc>,
    /// Đang ở phần lịch sử chép từ session cha (fork) → bỏ.
    inherited: bool,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<PermissionMode>,
    turns: Vec<Turn>,
    /// `call_id` → vị trí turn `tool_call`.
    tool_calls: HashMap<String, usize>,
    /// Vị trí prompt gần nhất (đầu lượt hiện tại).
    last_prompt: Option<usize>,
    /// `turn_id` của lượt hiện tại (từ `task_started`/`turn_context`).
    current_turn: Option<String>,
    /// (turn_id, text) của prompt đã thêm, để không thêm lại khi cùng prompt có ở cả
    /// `user_message` lẫn `item_completed`/`UserMessage`.
    prompted: HashSet<(String, String)>,
    /// `total_token_usage` của `token_count` trước (để khử event lặp).
    last_total: Option<Value>,
    /// Turn assistant đầu tiên sinh ra kể từ `token_count` trước.
    unbilled: Option<usize>,
    /// Usage tới trước khi có turn assistant nào.
    pending_usage: Option<Usage>,
    warnings: u32,
}

impl SessionBuilder {
    /// Dựng từ dòng `session_meta` đầu tiên; `None` nếu dòng không phải `session_meta` hợp lệ.
    fn from_meta(line: &Value) -> Option<Self> {
        if line.get("type").and_then(Value::as_str) != Some("session_meta") {
            return None;
        }
        let meta = line.get("payload")?;
        let raw_id = meta_id(meta)?.to_owned();
        let ts = line_ts(line).or_else(|| meta.get("timestamp").and_then(parse_ts))?;
        let parent = meta
            .pointer("/source/subagent/thread_spawn/parent_thread_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|p| AgentKind::Codex.source_id(p));
        Some(Self {
            id_time: uuid_v7_millis(&raw_id),
            raw_id,
            cwd: non_empty(meta, "cwd").map(PathBuf::from),
            version: non_empty(meta, "cli_version").map(|v| v.chars().take(64).collect()),
            branch: meta
                .pointer("/git/branch")
                .and_then(Value::as_str)
                .filter(|b| !b.is_empty() && *b != "HEAD")
                .map(str::to_owned),
            parent,
            started_at: ts,
            ended_at: ts,
            inherited: false,
            model: None,
            effort: None,
            permission_mode: None,
            turns: Vec::new(),
            tool_calls: HashMap::new(),
            last_prompt: None,
            current_turn: None,
            prompted: HashSet::new(),
            last_total: None,
            unbilled: None,
            pending_usage: None,
            warnings: 0,
        })
    }

    fn push(&mut self, line: &Value) {
        let Some(kind) = line.get("type").and_then(Value::as_str) else {
            self.warnings += 1;
            return;
        };
        let payload = line.get("payload").unwrap_or(&Value::Null);
        match kind {
            "session_meta" => {
                // Cùng id: ghi lại/resume. Khác id: bắt đầu phần chép của fork.
                if meta_id(payload) != Some(self.raw_id.as_str()) {
                    self.inherited = true;
                }
                return;
            }
            // `token_usage_record` (bản 0.17x) lặp lại số của `token_count`.
            "world_state" | "token_usage_record" => return,
            "turn_context" | "response_item" | "event_msg" | "compacted" => {}
            _ => {
                self.warnings += 1;
                return;
            }
        }
        let sub = payload.get("type").and_then(Value::as_str);
        if self.inherited {
            let starts_turn = kind == "turn_context" || sub == Some("task_started");
            let new_turn = starts_turn
                && payload
                    .get("turn_id")
                    .and_then(Value::as_str)
                    .is_some_and(|t| self.is_new_turn(t));
            if !new_turn {
                if sub == Some("token_count") {
                    // Giữ mốc cộng dồn để event lặp ngay sau phần chép không bị đếm.
                    if let Some(total) = payload.pointer("/info/total_token_usage") {
                        self.last_total = Some(total.clone());
                    }
                }
                return;
            }
            self.inherited = false;
        }
        let Some(ts) = line_ts(line) else {
            self.warnings += 1;
            return;
        };
        self.started_at = self.started_at.min(ts);
        self.ended_at = self.ended_at.max(ts);
        match kind {
            "turn_context" => self.turn_context(payload),
            "response_item" => self.response_item(payload, sub, ts),
            "event_msg" => self.event(payload, sub, ts),
            _ => self.compaction(payload, ts),
        }
    }

    /// Lượt có `turn_id` (UUIDv7) tạo sau session. Không đọc được mốc thời gian thì coi là
    /// mới (thà gửi trùng còn hơn mất dữ liệu).
    fn is_new_turn(&self, turn_id: &str) -> bool {
        match (self.id_time, uuid_v7_millis(turn_id)) {
            (Some(session), Some(turn)) => turn >= session,
            _ => true,
        }
    }

    fn turn_context(&mut self, p: &Value) {
        if let Some(turn) = non_empty(p, "turn_id") {
            self.current_turn = Some(turn.to_owned());
        }
        if let Some(model) = non_empty(p, "model") {
            self.model = Some(model.chars().take(128).collect());
        }
        let effort = non_empty(p, "effort")
            .or_else(|| non_empty(p, "reasoning_effort"))
            .or_else(|| {
                p.pointer("/collaboration_mode/settings/reasoning_effort")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
            });
        self.effort = effort.map(|e| e.chars().take(32).collect());
        if let Some(mode) = permission_mode(p) {
            if self
                .permission_mode
                .is_none_or(|old| mode_rank(mode) > mode_rank(old))
            {
                self.permission_mode = Some(mode);
            }
        }
    }

    fn response_item(&mut self, p: &Value, sub: Option<&str>, ts: DateTime<Utc>) {
        match sub {
            Some("message") => {
                if p.get("role").and_then(Value::as_str) == Some("assistant") {
                    self.reply(p, ts);
                }
            }
            Some("function_call") => {
                let input = match p.get("arguments") {
                    Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
                        Ok(Value::Object(m)) => Some(m),
                        _ => Some(single("arguments", Value::String(s.clone()))),
                    },
                    Some(Value::Object(m)) => Some(m.clone()),
                    _ => None,
                };
                self.tool_call(p, non_empty(p, "name"), input, ts);
            }
            Some("custom_tool_call") => {
                let name = non_empty(p, "name");
                let raw = p.get("input").and_then(Value::as_str).unwrap_or("");
                let mut input = single(
                    if name == Some(APPLY_PATCH) {
                        "patch"
                    } else {
                        "input"
                    },
                    Value::String(raw.to_owned()),
                );
                if name == Some(APPLY_PATCH) {
                    let paths = patch::input_paths(raw, self.cwd.as_deref());
                    if let Some(path) = patch::primary_path(&paths) {
                        input.insert("path".into(), Value::String(path.clone()));
                    }
                }
                self.tool_call(p, name, Some(input), ts);
            }
            Some("local_shell_call") => {
                let input = p.get("action").and_then(Value::as_object).cloned();
                self.tool_call(p, Some("local_shell"), input, ts);
            }
            Some("web_search_call") => {
                let input = p.get("action").and_then(Value::as_object).cloned();
                let i = self.tool_call(p, Some("web_search"), input, ts);
                // Không có output riêng: trạng thái nằm ngay trên call.
                if let Some(tool) = i.and_then(|i| self.turns[i].tool.as_mut()) {
                    tool.status = match p.get("status").and_then(Value::as_str) {
                        Some("completed") => Some(ToolStatus::Ok),
                        Some("failed") => Some(ToolStatus::Error),
                        _ => None,
                    };
                }
            }
            Some("tool_search_call") => {
                let input = p.get("arguments").and_then(Value::as_object).cloned();
                self.tool_call(p, Some("tool_search"), input, ts);
            }
            Some(
                "function_call_output"
                | "custom_tool_call_output"
                | "local_shell_call_output"
                | "tool_search_output",
            ) => self.tool_result(p, ts),
            // Suy luận đã mã hóa; ảnh chụp git nội bộ; bản nén ngữ cảnh (đã có `compacted`).
            // `additional_tools`: danh sách tool khai báo cho model (bản 0.17x).
            Some(
                "reasoning" | "ghost_snapshot" | "compaction" | "compaction_summary"
                | "additional_tools",
            ) => {}
            _ => self.warnings += 1,
        }
    }

    fn event(&mut self, p: &Value, sub: Option<&str>, ts: DateTime<Utc>) {
        match sub {
            Some("user_message") => {
                let raw = p.get("message").and_then(Value::as_str).unwrap_or("");
                let count = |k: &str| p.get(k).and_then(Value::as_array).map_or(0, Vec::len);
                let images = count("images") + count("local_images");
                self.prompt(None, raw, images, ts);
            }
            // Bản 0.17x bỏ `user_message`, prompt chỉ còn ở `item_completed`/`UserMessage`.
            Some("item_completed") => {
                let item = p.get("item").unwrap_or(&Value::Null);
                if item.get("type").and_then(Value::as_str) == Some("UserMessage") {
                    let mut texts = Vec::new();
                    let mut images = 0;
                    for part in item
                        .get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        match part.get("type").and_then(Value::as_str) {
                            Some("text" | "Text") => {
                                texts.extend(part.get("text").and_then(Value::as_str));
                            }
                            Some(t) if t.to_ascii_lowercase().contains("image") => images += 1,
                            _ => {}
                        }
                    }
                    let turn = non_empty(p, "turn_id").map(str::to_owned);
                    self.prompt(
                        turn,
                        &texts.join(
                            "
",
                        ),
                        images,
                        ts,
                    );
                }
            }
            Some("task_started") => {
                self.current_turn = non_empty(p, "turn_id").map(str::to_owned);
            }
            Some("token_count") => self.token_count(p),
            Some("turn_aborted") => self.mark_interrupted(),
            Some("patch_apply_end") => self.patch_applied(p),
            // Các event khác chỉ phục vụ giao diện hoặc lặp lại `response_item`.
            _ => {}
        }
    }

    /// Thêm prompt; `turn` là `turn_id` nếu nguồn có, không thì lượt hiện tại.
    fn prompt(&mut self, turn: Option<String>, raw: &str, images: usize, ts: DateTime<Utc>) {
        let text = strip_ide_context(raw);
        let images = u32::try_from(images).unwrap_or(u32::MAX);
        if text.trim().is_empty() && images == 0 {
            return;
        }
        // Chỉ khử trùng khi biết lượt (không có turn_id thì hai prompt giống nhau vẫn là hai).
        if let Some(turn_id) = turn.or_else(|| self.current_turn.clone()) {
            if !self.prompted.insert((turn_id, text.to_owned())) {
                return;
            }
        }
        let mut turn = Turn::new(0, Role::User, TurnKind::Prompt, ts);
        if !text.trim().is_empty() {
            turn.text = Some(text.to_owned());
        }
        turn.attachments = image_attachments(images);
        self.last_prompt = Some(self.turns.len());
        self.turns.push(turn);
    }

    fn reply(&mut self, p: &Value, ts: DateTime<Utc>) {
        let texts: Vec<&str> = match p.get("content") {
            Some(Value::Array(parts)) => parts
                .iter()
                .filter(|c| {
                    matches!(
                        c.get("type").and_then(Value::as_str),
                        Some("output_text" | "text")
                    )
                })
                .filter_map(|c| c.get("text").and_then(Value::as_str))
                .collect(),
            Some(Value::String(s)) => vec![s.as_str()],
            _ => {
                self.warnings += 1;
                return;
            }
        };
        let text = texts.join("\n");
        if text.trim().is_empty() {
            return;
        }
        let mut turn = Turn::new(0, Role::Assistant, TurnKind::Reply, ts);
        turn.text = Some(text);
        self.push_assistant(turn);
    }

    /// Thêm turn `tool_call`; trả vị trí turn (hoặc `None` khi thiếu tên tool).
    fn tool_call(
        &mut self,
        p: &Value,
        name: Option<&str>,
        input: Option<Map<String, Value>>,
        ts: DateTime<Utc>,
    ) -> Option<usize> {
        let Some(name) = name.filter(|n| !n.is_empty()) else {
            self.warnings += 1;
            return None;
        };
        let mut turn = Turn::new(0, Role::Assistant, TurnKind::ToolCall, ts);
        turn.tool = Some(Tool {
            name: name.to_owned(),
            input,
            status: None,
        });
        let i = self.push_assistant(turn);
        if let Some(id) = non_empty(p, "call_id").or_else(|| non_empty(p, "id")) {
            self.tool_calls.insert(id.to_owned(), i);
        }
        Some(i)
    }

    fn push_assistant(&mut self, mut turn: Turn) -> usize {
        turn.model = Some(self.model.clone());
        turn.reasoning_effort = Some(self.effort.clone());
        let i = self.turns.len();
        if let Some(usage) = self.pending_usage.take() {
            turn.usage = Some(usage);
        }
        self.unbilled.get_or_insert(i);
        self.turns.push(turn);
        i
    }

    fn tool_result(&mut self, p: &Value, ts: DateTime<Utc>) {
        let call = non_empty(p, "call_id").and_then(|id| self.tool_calls.get(id).copied());
        let (text, images, exit_code) = tool_output(p.get("output"));
        let mut status = if exit_code.is_some_and(|c| c != 0)
            || ERROR_OUTPUT_PREFIXES.iter().any(|x| text.starts_with(x))
        {
            ToolStatus::Error
        } else {
            ToolStatus::Ok
        };
        let call_tool = call.and_then(|i| self.turns[i].tool.as_mut());
        // `patch_apply_end.success = false` đã đánh dấu lỗi trước đó: giữ nguyên.
        if call_tool
            .as_ref()
            .is_some_and(|t| t.status == Some(ToolStatus::Error))
        {
            status = ToolStatus::Error;
        }
        let name = call_tool.map_or_else(
            || "unknown".to_owned(),
            |t| {
                t.status = Some(status);
                t.name.clone()
            },
        );
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
        self.turns.push(turn);
    }

    /// `patch_apply_end`: diff thật (có số dòng) và kết quả áp patch, gắn vào tool_call.
    fn patch_applied(&mut self, p: &Value) {
        let Some(i) = non_empty(p, "call_id").and_then(|id| self.tool_calls.get(id).copied())
        else {
            return;
        };
        if p.get("success").and_then(Value::as_bool) == Some(false) {
            if let Some(tool) = self.turns[i].tool.as_mut() {
                tool.status = Some(ToolStatus::Error);
            }
            return;
        }
        if let Some(changes) = p.get("changes").and_then(Value::as_object) {
            if let Some(diff) = patch::from_changes(changes, self.cwd.as_deref()) {
                self.turns[i].diff = Some(diff);
            }
        }
    }

    fn token_count(&mut self, p: &Value) {
        let Some(info) = p.get("info").filter(|i| i.is_object()) else {
            // `info: null`: chỉ cập nhật hạn mức (rate limit), không có số token.
            return;
        };
        if let Some(total) = info.get("total_token_usage") {
            if self.last_total.as_ref() == Some(total) {
                return;
            }
            self.last_total = Some(total.clone());
        }
        let Some(usage) = info.get("last_token_usage").and_then(parse_usage) else {
            self.warnings += 1;
            return;
        };
        let target = self.unbilled.take().or_else(|| {
            self.turns
                .iter()
                .rposition(|t| t.role == Role::Assistant && t.kind != TurnKind::Compaction)
        });
        match target {
            Some(i) => add_usage(&mut self.turns[i].usage, usage),
            None => add_usage(&mut self.pending_usage, usage),
        }
    }

    fn mark_interrupted(&mut self) {
        let from = self.last_prompt.unwrap_or(0);
        let target = self.turns[from..]
            .iter()
            .rposition(|t| t.role == Role::Assistant)
            .map(|i| from + i)
            .or(self.last_prompt);
        if let Some(i) = target {
            self.turns[i].interrupted = Some(true);
        }
    }

    fn compaction(&mut self, p: &Value, ts: DateTime<Utc>) {
        let mut turn = Turn::new(0, Role::System, TurnKind::Compaction, ts);
        if let Some(text) = non_empty(p, "message").filter(|t| !t.trim().is_empty()) {
            turn.text = Some(text.to_owned());
        }
        self.turns.push(turn);
    }

    fn finish(mut self) -> Option<NormalizedSession> {
        if self.turns.is_empty() {
            return None;
        }
        // `apply_patch` thành công mà log không có `patch_apply_end`: dựng diff từ input.
        let cwd = self.cwd.clone();
        for turn in &mut self.turns {
            let Some(tool) = turn.tool.as_ref() else {
                continue;
            };
            if turn.kind != TurnKind::ToolCall
                || turn.diff.is_some()
                || tool.name != APPLY_PATCH
                || tool.status != Some(ToolStatus::Ok)
            {
                continue;
            }
            let raw = tool
                .input
                .as_ref()
                .and_then(|i| i.get("patch"))
                .and_then(Value::as_str);
            turn.diff = raw.and_then(|r| patch::from_input(r, cwd.as_deref()));
        }
        for (seq, turn) in self.turns.iter_mut().enumerate() {
            turn.seq = u32::try_from(seq).unwrap_or(u32::MAX);
        }
        Some(NormalizedSession {
            cwd: self.cwd,
            session: Session {
                source_id: AgentKind::Codex.source_id(&self.raw_id),
                agent: AgentKind::Codex,
                agent_version: self.version,
                repo_remote: String::new(),
                branch: self.branch,
                cwd_relative: None,
                started_at: self.started_at,
                ended_at: Some(self.ended_at),
                parent_source_id: self.parent,
                permission_mode: self.permission_mode,
                instruction_files: None,
            },
            turns: self.turns,
            parse_warnings: self.warnings,
        })
    }
}

fn meta_id(meta: &Value) -> Option<&str> {
    non_empty(meta, "id").or_else(|| non_empty(meta, "session_id"))
}

fn non_empty<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn single(key: &str, value: Value) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(key.to_owned(), value);
    m
}

fn parse_ts(v: &Value) -> Option<DateTime<Utc>> {
    v.as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc))
}

fn line_ts(line: &Value) -> Option<DateTime<Utc>> {
    line.get("timestamp").and_then(parse_ts)
}

/// Mốc thời gian (ms Unix) của UUIDv7: 48 bit đầu. `None` nếu không phải UUIDv7.
pub(crate) fn uuid_v7_millis(id: &str) -> Option<u64> {
    let hex: String = id.chars().filter(|c| *c != '-').collect();
    if hex.len() != 32 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    if hex.as_bytes()[12] != b'7' {
        return None;
    }
    u64::from_str_radix(&hex[..12], 16).ok()
}

/// Bỏ khối ngữ cảnh IDE (danh sách tab...) do extension VS Code chèn trước prompt.
fn strip_ide_context(message: &str) -> &str {
    if !message.trim_start().starts_with(IDE_CONTEXT_PREFIX) {
        return message;
    }
    match message.find(IDE_REQUEST_MARKER) {
        Some(i) => message[i + IDE_REQUEST_MARKER.len()..].trim_start_matches(['\r', '\n']),
        None => message,
    }
}

/// Output của tool: (text, số ảnh, exit code nếu đọc được).
///
/// Dạng gặp trên log thật: chuỗi `Exit code: N\nWall time: ...\nOutput:\n...`; chuỗi
/// JSON `{"output": "...", "metadata": {"exit_code": N}}` (bản cũ); mảng content
/// (`input_text`/`input_image`).
fn tool_output(output: Option<&Value>) -> (String, u32, Option<i64>) {
    match output {
        Some(Value::String(s)) => {
            if s.starts_with('{') {
                if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(s) {
                    if let Some(text) = m.get("output").and_then(Value::as_str) {
                        let code = m
                            .get("metadata")
                            .and_then(|x| x.get("exit_code"))
                            .and_then(Value::as_i64);
                        return (text.to_owned(), 0, code);
                    }
                }
            }
            let code = s
                .lines()
                .next()
                .and_then(|l| l.strip_prefix("Exit code: "))
                .and_then(|c| c.trim().parse().ok());
            (s.clone(), 0, code)
        }
        Some(Value::Array(parts)) => {
            let mut texts = Vec::new();
            let mut images = 0u32;
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("input_image" | "image") => images += 1,
                    _ => {
                        if let Some(t) = part.get("text").and_then(Value::as_str) {
                            texts.push(t);
                        }
                    }
                }
            }
            (texts.join("\n"), images, None)
        }
        Some(Value::Object(m)) => {
            let text = m
                .get("output")
                .or_else(|| m.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let code = m
                .get("metadata")
                .and_then(|x| x.get("exit_code"))
                .and_then(Value::as_i64);
            (text.to_owned(), 0, code)
        }
        _ => (String::new(), 0, None),
    }
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

/// `approval_policy` + `sandbox_policy` (+ chế độ plan) → enum schema (RULES.md mục 4).
///
/// - `collaboration_mode.mode = plan` → `plan`.
/// - `never` + `danger-full-access`: không hỏi gì, không sandbox → `bypass`.
/// - `never` + `workspace-write`: tự sửa file và chạy lệnh trong sandbox → `accept_edits`.
/// - `on-request`/`untrusted`/`on-failure` + `read-only`/`workspace-write`: hỏi trước khi
///   vượt sandbox → `default`.
/// - Tổ hợp khác (vd. `on-request` + `danger-full-access`: lệnh chạy thẳng không hỏi
///   nhưng model vẫn có thể hỏi) → `unknown`.
fn permission_mode(p: &Value) -> Option<PermissionMode> {
    if p.pointer("/collaboration_mode/mode")
        .and_then(Value::as_str)
        == Some("plan")
    {
        return Some(PermissionMode::Plan);
    }
    let approval = p.get("approval_policy").and_then(Value::as_str)?;
    let sandbox = match p.get("sandbox_policy") {
        Some(Value::Object(m)) => m.get("type").and_then(Value::as_str),
        Some(Value::String(s)) => Some(s.as_str()),
        _ => None,
    };
    Some(match (approval, sandbox) {
        ("never", Some("danger-full-access")) => PermissionMode::Bypass,
        ("never", Some("workspace-write")) => PermissionMode::AcceptEdits,
        ("on-request" | "untrusted" | "on-failure", Some("read-only" | "workspace-write")) => {
            PermissionMode::Default
        }
        _ => PermissionMode::Unknown,
    })
}

fn mode_rank(mode: PermissionMode) -> u8 {
    match mode {
        PermissionMode::Unknown => 0,
        PermissionMode::Plan => 1,
        PermissionMode::Default => 2,
        PermissionMode::AcceptEdits => 3,
        PermissionMode::Bypass => 4,
    }
}

/// `last_token_usage` của OpenAI → [`Usage`] (`input` không gồm phần đọc từ cache).
fn parse_usage(u: &Value) -> Option<Usage> {
    let num = |k: &str| u.get(k).and_then(Value::as_u64);
    let input = num("input_tokens")?;
    let cached = num("cached_input_tokens").unwrap_or(0);
    Some(Usage {
        input: input.saturating_sub(cached),
        output: num("output_tokens")?,
        cache_read: Some(cached),
        cache_write: None,
        estimated: None,
    })
}

fn add_usage(slot: &mut Option<Usage>, u: Usage) {
    match slot {
        Some(old) => {
            old.input += u.input;
            old.output += u.output;
            old.cache_read = Some(old.cache_read.unwrap_or(0) + u.cache_read.unwrap_or(0));
        }
        None => *slot = Some(u),
    }
}
