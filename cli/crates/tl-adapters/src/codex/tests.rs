//! Unit test cho adapter Codex: từng quy tắc chuẩn hóa trên log dựng tay.
//! Snapshot trên log thật (đã che) nằm ở `tests/codex.rs`.

use serde_json::{json, Value};
use tl_core::session::{PermissionMode, Role, ToolStatus, TurnKind, Usage};

use super::*;

/// UUIDv7 tạo lúc 2026-06-25T09:45:07Z (mốc `019efe2b1883`).
const SID: &str = "019efe2b-1883-7a42-be74-f32566e718ac";
/// Session cha của fork, tạo trước.
const PARENT: &str = "019efe1c-0f48-7aa3-8500-769fdc5230af";
/// Lượt cũ (trước khi fork) và lượt mới (sau khi fork).
const OLD_TURN: &str = "019efe20-8da8-7262-922f-9f69613db0f4";
const NEW_TURN: &str = "019efe2c-0000-7000-8000-000000000001";
const OTHER_TURN: &str = "019efe2d-0000-7000-8000-000000000002";

fn ev(values: Vec<Value>) -> Vec<RawEvent> {
    values
        .into_iter()
        .enumerate()
        .map(|(i, value)| RawEvent {
            offset: Offset(i as u64),
            value,
        })
        .collect()
}

fn line(ts: &str, kind: &str, payload: Value) -> Value {
    json!({ "timestamp": ts, "type": kind, "payload": payload })
}

fn meta(ts: &str, id: &str) -> Value {
    line(
        ts,
        "session_meta",
        json!({
            "id": id, "timestamp": ts, "cwd": "C:\\repo", "originator": "codex_cli_rs",
            "cli_version": "0.142.5", "source": "cli",
            "git": { "branch": "main", "commit_hash": "abc" }
        }),
    )
}

fn context(ts: &str, turn: &str, effort: &str, approval: &str, sandbox: &str) -> Value {
    line(
        ts,
        "turn_context",
        json!({
            "turn_id": turn, "cwd": "C:\\repo", "model": "gpt-5.5", "effort": effort,
            "approval_policy": approval, "sandbox_policy": { "type": sandbox },
            "collaboration_mode": { "mode": "default", "settings": { "reasoning_effort": effort } }
        }),
    )
}

fn event(ts: &str, payload: Value) -> Value {
    line(ts, "event_msg", payload)
}

fn item(ts: &str, payload: Value) -> Value {
    line(ts, "response_item", payload)
}

fn user_message(ts: &str, text: &str) -> Value {
    event(
        ts,
        json!({ "type": "user_message", "message": text, "images": [], "local_images": [] }),
    )
}

fn reply(ts: &str, text: &str) -> Value {
    item(
        ts,
        json!({ "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": text }] }),
    )
}

fn tokens(ts: &str, total: (u64, u64, u64), last: (u64, u64, u64)) -> Value {
    let u = |(i, c, o): (u64, u64, u64)| {
        json!({ "input_tokens": i, "cached_input_tokens": c, "output_tokens": o,
                "reasoning_output_tokens": 0, "total_tokens": i + o })
    };
    event(
        ts,
        json!({ "type": "token_count", "info": { "total_token_usage": u(total), "last_token_usage": u(last) } }),
    )
}

fn one(values: Vec<Value>) -> NormalizedSession {
    let mut sessions = CodexAdapter::new("unused").normalize(ev(values));
    assert_eq!(sessions.len(), 1, "phải ra đúng một session");
    sessions.remove(0)
}

fn usage(input: u64, cache: u64, output: u64) -> Option<Usage> {
    Some(Usage {
        input,
        output,
        cache_read: Some(cache),
        cache_write: None,
        estimated: None,
    })
}

#[test]
fn session_metadata_from_session_meta() {
    let s = one(vec![
        meta("2026-06-25T09:45:07.000Z", SID),
        context(
            "2026-06-25T09:45:08Z",
            NEW_TURN,
            "high",
            "on-request",
            "workspace-write",
        ),
        user_message("2026-06-25T09:45:09Z", "liệt kê file"),
        reply("2026-06-25T09:45:10Z", "Có 3 file."),
    ]);
    assert_eq!(s.session.source_id, format!("codex:{SID}"));
    assert_eq!(s.session.agent, AgentKind::Codex);
    assert_eq!(s.session.agent_version.as_deref(), Some("0.142.5"));
    assert_eq!(s.session.branch.as_deref(), Some("main"));
    assert_eq!(s.cwd.as_deref(), Some(std::path::Path::new("C:\\repo")));
    assert_eq!(s.session.permission_mode, Some(PermissionMode::Default));
    assert_eq!(s.session.parent_source_id, None);
    assert_eq!(
        s.session.started_at.to_rfc3339(),
        "2026-06-25T09:45:07+00:00"
    );
    assert_eq!(
        s.session.ended_at.map(|t| t.to_rfc3339()).as_deref(),
        Some("2026-06-25T09:45:10+00:00")
    );
    assert_eq!(s.parse_warnings, 0);
    let kinds: Vec<_> = s.turns.iter().map(|t| (t.seq, t.kind)).collect();
    assert_eq!(kinds, vec![(0, TurnKind::Prompt), (1, TurnKind::Reply)]);
    // Prompt không có model; reply mang model + reasoning_effort của turn_context.
    assert_eq!(s.turns[0].model, None);
    assert_eq!(s.turns[1].model, Some(Some("gpt-5.5".into())));
    assert_eq!(s.turns[1].reasoning_effort, Some(Some("high".into())));
}

#[test]
fn injected_messages_are_not_prompts() {
    let s = one(vec![
        meta("2026-06-25T09:45:07Z", SID),
        item(
            "2026-06-25T09:45:08Z",
            json!({ "type": "message", "role": "developer", "content": [{ "type": "input_text", "text": "<permissions instructions>..." }] }),
        ),
        item(
            "2026-06-25T09:45:08Z",
            json!({ "type": "message", "role": "user", "content": [
                { "type": "input_text", "text": "# AGENTS.md instructions\n\n<INSTRUCTIONS>..." },
                { "type": "input_text", "text": "<environment_context>\n  <cwd>C:\\repo</cwd>" }
            ] }),
        ),
        item(
            "2026-06-25T09:45:09Z",
            json!({ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "sửa lỗi" }] }),
        ),
        event(
            "2026-06-25T09:45:09Z",
            json!({
                "type": "user_message",
                "message": "# Context from my IDE setup:\n\n## Open tabs:\n- a.ts: a.ts\n\n## My request for Codex:\nsửa lỗi",
                "images": ["data:image/png;base64,AAAA"], "local_images": []
            }),
        ),
        // Bản lặp cho giao diện của câu trả lời.
        event(
            "2026-06-25T09:45:10Z",
            json!({ "type": "agent_message", "message": "Xong." }),
        ),
        reply("2026-06-25T09:45:10Z", "Xong."),
    ]);
    assert_eq!(s.turns.len(), 2);
    assert_eq!(s.turns[0].text.as_deref(), Some("sửa lỗi"));
    assert_eq!(s.turns[0].role, Role::User);
    assert_eq!(s.turns[0].attachments[0].count, 1);
    assert_eq!(s.parse_warnings, 0);
}

#[test]
fn token_count_dedup_and_cached_split() {
    let s = one(vec![
        meta("2026-06-25T09:45:07Z", SID),
        context(
            "2026-06-25T09:45:08Z",
            NEW_TURN,
            "medium",
            "never",
            "danger-full-access",
        ),
        user_message("2026-06-25T09:45:09Z", "chạy test"),
        // `info: null` chỉ là hạn mức.
        event(
            "2026-06-25T09:45:09Z",
            json!({ "type": "token_count", "info": null, "rate_limits": {} }),
        ),
        item(
            "2026-06-25T09:45:10Z",
            json!({ "type": "reasoning", "summary": [], "encrypted_content": "x" }),
        ),
        item(
            "2026-06-25T09:45:10Z",
            json!({ "type": "function_call", "name": "shell_command", "call_id": "c1",
                    "arguments": "{\"command\":\"cargo test\",\"workdir\":\"C:\\\\repo\"}" }),
        ),
        tokens("2026-06-25T09:45:10Z", (100, 40, 10), (100, 40, 10)),
        // Event lặp (total không đổi) không được đếm lại.
        tokens("2026-06-25T09:45:10Z", (100, 40, 10), (100, 40, 10)),
        item(
            "2026-06-25T09:45:12Z",
            json!({ "type": "function_call_output", "call_id": "c1", "output": "Exit code: 101\nWall time: 1 seconds\nOutput:\nlỗi" }),
        ),
        reply("2026-06-25T09:45:13Z", "Test hỏng."),
        tokens("2026-06-25T09:45:13Z", (250, 120, 30), (150, 80, 20)),
        // Lần gọi chỉ có reasoning: cộng vào turn assistant gần nhất.
        tokens("2026-06-25T09:45:14Z", (260, 120, 35), (10, 0, 5)),
    ]);
    assert_eq!(s.session.permission_mode, Some(PermissionMode::Bypass));
    let call = &s.turns[1];
    assert_eq!(call.kind, TurnKind::ToolCall);
    let tool = call.tool.as_ref().unwrap();
    assert_eq!(tool.name, "shell_command");
    assert_eq!(tool.input.as_ref().unwrap()["command"], "cargo test");
    assert_eq!(tool.status, Some(ToolStatus::Error));
    assert_eq!(call.usage, usage(60, 40, 10));
    let result = &s.turns[2];
    assert_eq!(result.kind, TurnKind::ToolResult);
    assert_eq!(result.tool.as_ref().unwrap().name, "shell_command");
    assert!(result.output.as_ref().unwrap().text.ends_with("lỗi"));
    assert_eq!(s.turns[3].usage, usage(80, 80, 25));
    // Tổng input + cache_read = total input; output = total output.
    let sum = |f: fn(&Usage) -> u64| {
        s.turns
            .iter()
            .filter_map(|t| t.usage.as_ref())
            .map(f)
            .sum::<u64>()
    };
    assert_eq!(sum(|u| u.input + u.cache_read.unwrap_or(0)), 260);
    assert_eq!(sum(|u| u.output), 35);
}

#[test]
fn apply_patch_diff_from_patch_apply_end_and_fallback() {
    let patch_input = "*** Begin Patch\n*** Update File: src/a.rs\n@@\n-a\n+b\n*** End Patch\n";
    let s = one(vec![
        meta("2026-06-25T09:45:07Z", SID),
        user_message("2026-06-25T09:45:08Z", "sửa a.rs"),
        item(
            "2026-06-25T09:45:09Z",
            json!({ "type": "custom_tool_call", "name": "apply_patch", "call_id": "p1", "input": patch_input }),
        ),
        event(
            "2026-06-25T09:45:09Z",
            json!({ "type": "patch_apply_end", "call_id": "p1", "success": true,
                    "changes": { "C:\\repo\\src\\a.rs": { "type": "update", "unified_diff": "@@ -1 +1 @@\n-a\n+b\n", "move_path": null } } }),
        ),
        item(
            "2026-06-25T09:45:09Z",
            json!({ "type": "custom_tool_call_output", "call_id": "p1",
                    "output": "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM src/a.rs\n" }),
        ),
        // Bản cũ: không có patch_apply_end, output dạng JSON.
        item(
            "2026-06-25T09:45:10Z",
            json!({ "type": "custom_tool_call", "name": "apply_patch", "call_id": "p2", "input": patch_input }),
        ),
        item(
            "2026-06-25T09:45:10Z",
            json!({ "type": "custom_tool_call_output", "call_id": "p2",
                    "output": "{\"output\":\"Success.\",\"metadata\":{\"exit_code\":0}}" }),
        ),
        // Áp patch thất bại: không có diff, trạng thái lỗi.
        item(
            "2026-06-25T09:45:11Z",
            json!({ "type": "custom_tool_call", "name": "apply_patch", "call_id": "p3", "input": patch_input }),
        ),
        event(
            "2026-06-25T09:45:11Z",
            json!({ "type": "patch_apply_end", "call_id": "p3", "success": false, "changes": {} }),
        ),
        item(
            "2026-06-25T09:45:11Z",
            json!({ "type": "custom_tool_call_output", "call_id": "p3", "output": "apply_patch verification failed: ..." }),
        ),
    ]);
    let calls: Vec<_> = s
        .turns
        .iter()
        .filter(|t| t.kind == TurnKind::ToolCall)
        .collect();
    assert_eq!(calls.len(), 3);
    let input = calls[0].tool.as_ref().unwrap().input.as_ref().unwrap();
    assert_eq!(input["path"], "C:\\repo\\src\\a.rs");
    assert_eq!(input["patch"], patch_input);
    let d = calls[0].diff.as_ref().unwrap();
    assert_eq!(
        (d.path.as_str(), d.patch.as_str()),
        ("C:\\repo\\src\\a.rs", "@@ -1 +1 @@\n-a\n+b\n")
    );
    let d = calls[1].diff.as_ref().unwrap();
    assert_eq!(
        (d.path.as_str(), d.added, d.removed),
        ("C:\\repo\\src\\a.rs", 1, 1)
    );
    assert_eq!(calls[1].tool.as_ref().unwrap().status, Some(ToolStatus::Ok));
    assert!(calls[2].diff.is_none());
    assert_eq!(
        calls[2].tool.as_ref().unwrap().status,
        Some(ToolStatus::Error)
    );
}

#[test]
fn turn_aborted_marks_last_assistant_turn_of_the_turn() {
    let s = one(vec![
        meta("2026-06-25T09:45:07Z", SID),
        user_message("2026-06-25T09:45:08Z", "làm A"),
        reply("2026-06-25T09:45:09Z", "Đang làm A."),
        item(
            "2026-06-25T09:45:10Z",
            json!({ "type": "function_call", "name": "shell_command", "call_id": "c1", "arguments": "{\"command\":\"sleep 100\"}" }),
        ),
        event(
            "2026-06-25T09:45:11Z",
            json!({ "type": "turn_aborted", "turn_id": NEW_TURN, "reason": "interrupted" }),
        ),
        // Lượt bị ngắt trước khi agent kịp trả lời: đánh dấu chính prompt.
        user_message("2026-06-25T09:45:12Z", "thôi, làm B"),
        event(
            "2026-06-25T09:45:13Z",
            json!({ "type": "turn_aborted", "reason": "interrupted" }),
        ),
    ]);
    let marked: Vec<_> = s
        .turns
        .iter()
        .filter(|t| t.interrupted == Some(true))
        .map(|t| (t.seq, t.kind))
        .collect();
    assert_eq!(marked, vec![(2, TurnKind::ToolCall), (3, TurnKind::Prompt)]);
}

#[test]
fn fork_skips_history_copied_from_parent() {
    let s = one(vec![
        // Session fork: meta của chính nó, rồi lịch sử chép từ cha (dấu thời gian mới).
        line(
            "2026-06-25T09:45:07.866Z",
            "session_meta",
            json!({ "id": SID, "forked_from_id": PARENT, "cwd": "C:\\repo", "cli_version": "0.142.0" }),
        ),
        meta("2026-06-25T09:45:07.866Z", PARENT),
        event(
            "2026-06-25T09:45:07.866Z",
            json!({ "type": "task_started", "turn_id": OLD_TURN }),
        ),
        context(
            "2026-06-25T09:45:07.866Z",
            OLD_TURN,
            "low",
            "on-request",
            "workspace-write",
        ),
        user_message("2026-06-25T09:45:07.867Z", "câu hỏi cũ của session cha"),
        reply("2026-06-25T09:45:07.867Z", "trả lời cũ"),
        tokens("2026-06-25T09:45:07.867Z", (500, 100, 50), (500, 100, 50)),
        event(
            "2026-06-25T09:45:08.028Z",
            json!({ "type": "thread_rolled_back", "num_turns": 1 }),
        ),
        // Lượt mới của fork.
        event(
            "2026-06-25T09:46:00Z",
            json!({ "type": "task_started", "turn_id": NEW_TURN }),
        ),
        context(
            "2026-06-25T09:46:00Z",
            NEW_TURN,
            "high",
            "never",
            "workspace-write",
        ),
        user_message("2026-06-25T09:46:01Z", "câu hỏi mới"),
        reply("2026-06-25T09:46:02Z", "trả lời mới"),
        tokens("2026-06-25T09:46:02Z", (900, 400, 60), (400, 300, 10)),
    ]);
    let texts: Vec<_> = s.turns.iter().filter_map(|t| t.text.as_deref()).collect();
    assert_eq!(texts, vec!["câu hỏi mới", "trả lời mới"]);
    assert_eq!(s.session.source_id, format!("codex:{SID}"));
    assert_eq!(s.session.parent_source_id, None, "fork không phải subagent");
    // Chỉ lượt mới: accept_edits (never + workspace-write), không lấy `default` của cha.
    assert_eq!(s.session.permission_mode, Some(PermissionMode::AcceptEdits));
    assert_eq!(s.turns[1].reasoning_effort, Some(Some("high".into())));
    assert_eq!(s.turns[1].usage, usage(100, 300, 10));
    assert_eq!(
        s.session.started_at.to_rfc3339(),
        "2026-06-25T09:45:07.866+00:00"
    );
    assert_eq!(s.parse_warnings, 0);
}

#[test]
fn fork_without_new_turns_yields_nothing() {
    let sessions = CodexAdapter::new("unused").normalize(ev(vec![
        line(
            "2026-06-25T09:45:07Z",
            "session_meta",
            json!({ "id": SID, "forked_from_id": PARENT }),
        ),
        meta("2026-06-25T09:45:07Z", PARENT),
        user_message("2026-06-25T09:45:07Z", "cũ"),
        reply("2026-06-25T09:45:07Z", "cũ"),
    ]));
    assert!(sessions.is_empty());
}

#[test]
fn repeated_own_session_meta_is_resume() {
    let s = one(vec![
        meta("2026-06-25T09:45:07Z", SID),
        user_message("2026-06-25T09:45:08Z", "một"),
        meta("2026-06-25T09:50:00Z", SID),
        user_message("2026-06-25T09:50:01Z", "hai"),
    ]);
    assert_eq!(s.turns.len(), 2);
}

#[test]
fn subagent_has_parent_source_id() {
    let s = one(vec![
        line(
            "2026-06-25T09:45:07Z",
            "session_meta",
            json!({ "id": SID, "cwd": "C:\\repo",
                    "source": { "subagent": { "thread_spawn": { "parent_thread_id": PARENT, "depth": 1 } } } }),
        ),
        user_message("2026-06-25T09:45:08Z", "việc con"),
    ]);
    assert_eq!(s.session.parent_source_id, Some(format!("codex:{PARENT}")));
}

#[test]
fn compaction_and_other_tools() {
    let s = one(vec![
        meta("2026-06-25T09:45:07Z", SID),
        line(
            "2026-06-25T09:45:08Z",
            "compacted",
            json!({ "message": "", "replacement_history": [] }),
        ),
        event(
            "2026-06-25T09:45:08Z",
            json!({ "type": "context_compacted" }),
        ),
        item(
            "2026-06-25T09:45:09Z",
            json!({ "type": "web_search_call", "status": "completed", "action": { "type": "search", "query": "rust" } }),
        ),
        item(
            "2026-06-25T09:45:10Z",
            json!({ "type": "custom_tool_call_output", "call_id": "khong-co", "output": [
                { "type": "input_text", "text": "ảnh:" }, { "type": "input_image", "image_url": "data:..." }
            ] }),
        ),
        line(
            "2026-06-25T09:45:10Z",
            "world_state",
            json!({ "full": true }),
        ),
    ]);
    assert_eq!(s.turns[0].kind, TurnKind::Compaction);
    assert_eq!(s.turns[0].role, Role::System);
    assert_eq!(s.turns[0].text, None);
    let search = s.turns[1].tool.as_ref().unwrap();
    assert_eq!(
        (search.name.as_str(), search.status),
        ("web_search", Some(ToolStatus::Ok))
    );
    assert_eq!(s.turns[2].tool.as_ref().unwrap().name, "unknown");
    assert_eq!(s.turns[2].attachments[0].count, 1);
    assert_eq!(s.parse_warnings, 0);
}

#[test]
fn unknown_and_broken_lines_are_warnings() {
    let s = one(vec![
        Value::Null, // dòng hỏng trước session_meta
        meta("2026-06-25T09:45:07Z", SID),
        Value::Null,
        line("2026-06-25T09:45:08Z", "kieu_moi", json!({})),
        item("2026-06-25T09:45:08Z", json!({ "type": "loai_item_moi" })),
        json!({ "type": "response_item", "payload": { "type": "message", "role": "assistant", "content": [] } }),
        user_message("2026-06-25T09:45:09Z", "ok"),
        // event lạ: bỏ có chủ đích, không cảnh báo.
        event("2026-06-25T09:45:09Z", json!({ "type": "su_kien_moi" })),
    ]);
    assert_eq!(s.turns.len(), 1);
    // null trước meta, null, type lạ, item lạ, dòng thiếu timestamp.
    assert_eq!(s.parse_warnings, 5);
}

#[test]
fn no_session_meta_no_session() {
    let sessions =
        CodexAdapter::new("unused").normalize(ev(vec![user_message("2026-06-25T09:45:09Z", "x")]));
    assert!(sessions.is_empty());
}

#[test]
fn uuid_v7_millis_reads_timestamp() {
    assert_eq!(normalize::uuid_v7_millis(SID), Some(0x019efe2b1883));
    assert_eq!(
        normalize::uuid_v7_millis("11111111-2222-4333-8444-555555555555"),
        None
    );
    assert_eq!(normalize::uuid_v7_millis("khong-phai-uuid"), None);
}

#[test]
fn discover_finds_sessions_and_archived() {
    let dir = tempfile::tempdir().unwrap();
    let day = dir.path().join("sessions/2026/06/25");
    std::fs::create_dir_all(&day).unwrap();
    std::fs::write(
        day.join(format!("rollout-2026-06-25T16-45-02-{SID}.jsonl")),
        "{}\n",
    )
    .unwrap();
    std::fs::write(day.join("ghi-chu.jsonl"), "{}\n").unwrap();
    std::fs::write(day.join("rollout-x.json"), "{}\n").unwrap();
    let archived = dir.path().join("archived_sessions");
    std::fs::create_dir_all(&archived).unwrap();
    std::fs::write(
        archived.join(format!("rollout-2026-06-24-{PARENT}.jsonl")),
        "{}\n",
    )
    .unwrap();
    let files = CodexAdapter::new(dir.path()).discover();
    let names: Vec<_> = files
        .iter()
        .map(|f| f.path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(files
        .iter()
        .all(|f| f.agent == AgentKind::Codex && f.size == 3));
    assert!(CodexAdapter::new(dir.path().join("khong-co"))
        .discover()
        .is_empty());
}

#[test]
fn prompt_from_item_completed_in_0_172_without_duplicates() {
    let item_user = |ts: &str, turn: &str, text: &str| {
        event(
            ts,
            json!({ "type": "item_completed", "turn_id": turn,
                    "item": { "type": "UserMessage", "content": [{ "type": "text", "text": text }] } }),
        )
    };
    let s = one(vec![
        meta("2026-11-26T21:01:11Z", SID),
        event(
            "2026-11-26T21:01:11Z",
            json!({ "type": "task_started", "turn_id": NEW_TURN }),
        ),
        item(
            "2026-11-26T21:01:12Z",
            json!({ "type": "additional_tools", "role": "developer", "tools": [] }),
        ),
        context(
            "2026-11-26T21:01:12Z",
            NEW_TURN,
            "medium",
            "never",
            "danger-full-access",
        ),
        // Bản 0.172: chỉ có item_completed, không có user_message.
        item_user("2026-11-26T21:01:13Z", NEW_TURN, "liệt kê file"),
        event(
            "2026-11-26T21:01:15Z",
            json!({ "type": "item_completed", "turn_id": NEW_TURN,
                    "item": { "type": "AgentMessage", "content": [{ "type": "Text", "text": "Đang xem." }] } }),
        ),
        reply("2026-11-26T21:01:15Z", "Đang xem."),
        line(
            "2026-11-26T21:01:16Z",
            "token_usage_record",
            json!({ "usage": { "input_tokens": 10, "output_tokens": 1 } }),
        ),
        tokens("2026-11-26T21:01:16Z", (10, 0, 1), (10, 0, 1)),
        // Lượt sau: có cả user_message lẫn item_completed cùng chữ → một prompt.
        context(
            "2026-11-26T21:02:00Z",
            OTHER_TURN,
            "medium",
            "never",
            "danger-full-access",
        ),
        user_message("2026-11-26T21:02:01Z", "tiếp"),
        item_user("2026-11-26T21:02:01Z", OTHER_TURN, "tiếp"),
    ]);
    let prompts: Vec<_> = s
        .turns
        .iter()
        .filter(|t| t.kind == TurnKind::Prompt)
        .map(|t| t.text.as_deref().unwrap())
        .collect();
    assert_eq!(prompts, vec!["liệt kê file", "tiếp"]);
    assert_eq!(s.turns[1].usage, usage(10, 0, 1));
    assert_eq!(s.parse_warnings, 0);
}
