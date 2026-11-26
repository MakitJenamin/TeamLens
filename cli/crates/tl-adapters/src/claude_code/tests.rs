//! Unit test cho adapter Claude Code: từng quy tắc chuẩn hóa trên log dựng tay.
//! Snapshot trên log thật (đã che) nằm ở `tests/claude_code.rs`.

use serde_json::{json, Value};
use tl_core::session::{PermissionMode, Role, ToolStatus, TurnKind};

use super::*;

const SID: &str = "11111111-2222-3333-4444-555555555555";

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

fn user(ts: &str, content: Value) -> Value {
    json!({
        "type": "user", "sessionId": SID, "timestamp": ts, "cwd": "C:\\repo",
        "version": "2.1.332", "gitBranch": "main", "message": { "role": "user", "content": content }
    })
}

fn assistant(ts: &str, id: &str, blocks: Value) -> Value {
    json!({
        "type": "assistant", "sessionId": SID, "timestamp": ts, "cwd": "C:\\repo",
        "version": "2.1.332", "gitBranch": "main",
        "message": {
            "id": id, "role": "assistant", "model": "claude-opus-5-5", "content": blocks,
            "usage": { "input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 7 }
        }
    })
}

fn one(values: Vec<Value>) -> NormalizedSession {
    let mut sessions = ClaudeCodeAdapter::new("unused").normalize(ev(values));
    assert_eq!(sessions.len(), 1, "phải ra đúng một session");
    sessions.remove(0)
}

#[test]
fn usage_counted_once_per_message_id() {
    let s = one(vec![
        user("2026-11-26T08:00:00Z", json!("sửa lỗi")),
        // Cùng message.id, ba dòng, usage lặp lại trên mỗi dòng.
        assistant(
            "2026-11-26T08:00:01Z",
            "msg_1",
            json!([{ "type": "thinking", "thinking": "..." }]),
        ),
        assistant(
            "2026-11-26T08:00:02Z",
            "msg_1",
            json!([{ "type": "text", "text": "Đọc file trước." }]),
        ),
        assistant(
            "2026-11-26T08:00:03Z",
            "msg_1",
            json!([{ "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "C:\\repo\\a.rs" } }]),
        ),
        assistant(
            "2026-11-26T08:00:05Z",
            "msg_2",
            json!([{ "type": "text", "text": "Xong." }]),
        ),
    ]);
    let kinds: Vec<_> = s.turns.iter().map(|t| t.kind).collect();
    assert_eq!(
        kinds,
        [
            TurnKind::Prompt,
            TurnKind::Reply,
            TurnKind::ToolCall,
            TurnKind::Reply
        ]
    );
    let with_usage: Vec<u32> = s
        .turns
        .iter()
        .filter(|t| t.usage.is_some())
        .map(|t| t.seq)
        .collect();
    // Thinking không thành turn nên usage của msg_1 rơi vào reply (seq 1), không lặp ở tool_call.
    assert_eq!(with_usage, [1, 3]);
    let total: u64 = s
        .turns
        .iter()
        .filter_map(|t| t.usage.as_ref())
        .map(|u| u.input)
        .sum();
    assert_eq!(total, 20);
    let u = s.turns[1].usage.as_ref().unwrap();
    assert_eq!(
        (u.output, u.cache_read, u.cache_write),
        (5, Some(100), Some(7))
    );
    assert_eq!(s.turns[1].model, Some(Some("claude-opus-5-5".into())));
    assert_eq!(s.turns[1].reasoning_effort, Some(None));
    assert_eq!(s.turns[0].model, None);
}

#[test]
fn broken_and_unknown_lines_are_counted_not_fatal() {
    let mut events = ev(vec![
        user("2026-11-26T08:00:00Z", json!("xin chào")),
        json!({ "type": "brand-new-event", "sessionId": SID }),
        json!({ "type": "summary", "summary": "tiêu đề", "leafUuid": "x" }),
        json!({ "type": "file-history-snapshot", "messageId": "m", "snapshot": {} }),
        json!({ "type": "user", "sessionId": SID, "message": { "content": "thiếu timestamp" } }),
        json!(42),
        assistant(
            "2026-11-26T08:00:01Z",
            "m1",
            json!([{ "type": "mystery_block" }, { "type": "text", "text": "ok" }]),
        ),
    ]);
    events.insert(1, RawEvent::unparsed(Offset(99)));
    let sessions = ClaudeCodeAdapter::new("unused").normalize(events);
    assert_eq!(sessions.len(), 1);
    let s = &sessions[0];
    // unparsed + type lạ + thiếu timestamp + số 42 + block lạ = 5; summary/snapshot bỏ có chủ đích.
    assert_eq!(s.parse_warnings, 5);
    assert_eq!(s.turns.len(), 2);
    assert_eq!(s.turns[1].text.as_deref(), Some("ok"));
}

#[test]
fn warnings_before_first_session_line_are_kept() {
    let mut events = vec![RawEvent::unparsed(Offset(0))];
    events.extend(ev(vec![user("2026-11-26T08:00:00Z", json!("hi"))]));
    let s = &ClaudeCodeAdapter::new("unused").normalize(events)[0];
    assert_eq!(s.parse_warnings, 1);
}

#[test]
fn interrupt_marks_previous_assistant_turn() {
    let s = one(vec![
        user("2026-11-26T08:00:00Z", json!("chạy test")),
        assistant(
            "2026-11-26T08:00:01Z",
            "m1",
            json!([{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "pnpm test" } }]),
        ),
        user(
            "2026-11-26T08:00:02Z",
            json!([{ "type": "tool_result", "tool_use_id": "t1", "is_error": true,
                     "content": "The user doesn't want to proceed with this tool use." }]),
        ),
        user(
            "2026-11-26T08:00:03Z",
            json!([{ "type": "text", "text": "[Request interrupted by user for tool use]" }]),
        ),
        user(
            "2026-11-26T08:00:04Z",
            json!("[Request interrupted by user]\n"),
        ),
    ]);
    assert_eq!(s.turns.len(), 3, "tin nhắn interrupt không thành prompt");
    assert_eq!(s.turns[1].kind, TurnKind::ToolCall);
    assert_eq!(s.turns[1].interrupted, Some(true));
    assert_eq!(
        s.turns[1].tool.as_ref().unwrap().status,
        Some(ToolStatus::Error)
    );
    assert_eq!(s.turns[2].interrupted, None);
}

#[test]
fn permission_mode_from_first_user_line() {
    let cases = [
        ("default", PermissionMode::Default),
        ("acceptEdits", PermissionMode::AcceptEdits),
        ("plan", PermissionMode::Plan),
        ("bypassPermissions", PermissionMode::Bypass),
        ("auto", PermissionMode::Unknown),
        ("dontAsk", PermissionMode::Unknown),
        ("somethingNew", PermissionMode::Unknown),
    ];
    for (raw, expected) in cases {
        let mut first = user("2026-11-26T08:00:00Z", json!("a"));
        first["permissionMode"] = json!(raw);
        let mut second = user("2026-11-26T08:00:01Z", json!("b"));
        second["permissionMode"] = json!("plan");
        let s = one(vec![first, second]);
        assert_eq!(s.session.permission_mode, Some(expected), "{raw}");
    }
    let s = one(vec![user("2026-11-26T08:00:00Z", json!("a"))]);
    assert_eq!(s.session.permission_mode, None);
}

#[test]
fn edit_diff_attached_to_tool_call() {
    let mut result = user(
        "2026-11-26T08:00:02Z",
        json!([{ "type": "tool_result", "tool_use_id": "t1", "content": "The file C:\\repo\\a.ts has been updated." }]),
    );
    result["toolUseResult"] = json!({
        "filePath": "C:\\repo\\a.ts",
        "structuredPatch": [{ "oldStart": 3, "oldLines": 1, "newStart": 3, "newLines": 2, "lines": ["-a", "+b", "+c"] }]
    });
    let s = one(vec![
        user("2026-11-26T08:00:00Z", json!("sửa a.ts")),
        assistant(
            "2026-11-26T08:00:01Z",
            "m1",
            json!([{ "type": "tool_use", "id": "t1", "name": "Edit",
                     "input": { "file_path": "C:\\repo\\a.ts", "old_string": "a", "new_string": "b\nc" } }]),
        ),
        result,
    ]);
    let call = &s.turns[1];
    let diff = call.diff.as_ref().expect("diff trên tool_call");
    assert_eq!(diff.path, "C:\\repo\\a.ts");
    assert_eq!(diff.patch, "@@ -3,1 +3,2 @@\n-a\n+b\n+c\n");
    assert_eq!((diff.added, diff.removed), (2, 1));
    assert_eq!(call.tool.as_ref().unwrap().status, Some(ToolStatus::Ok));
    let res = &s.turns[2];
    assert_eq!(res.kind, TurnKind::ToolResult);
    assert_eq!(res.tool.as_ref().unwrap().name, "Edit");
    assert!(res.tool.as_ref().unwrap().input.is_none());
    assert!(res.diff.is_none());
    let out = res.output.as_ref().unwrap();
    assert!(!out.truncated && out.original_bytes.is_none());
}

#[test]
fn edit_without_structured_patch_falls_back_to_input_and_errors_have_no_diff() {
    let edit = |id: &str| {
        json!([{ "type": "tool_use", "id": id, "name": "Edit",
                 "input": { "file_path": "/r/a.rs", "old_string": "x", "new_string": "y" } }])
    };
    let s = one(vec![
        user("2026-11-26T08:00:00Z", json!("sửa")),
        assistant("2026-11-26T08:00:01Z", "m1", edit("t1")),
        user(
            "2026-11-26T08:00:02Z",
            json!([{ "type": "tool_result", "tool_use_id": "t1", "content": "ok" }]),
        ),
        assistant("2026-11-26T08:00:03Z", "m2", edit("t2")),
        user(
            "2026-11-26T08:00:04Z",
            json!([{ "type": "tool_result", "tool_use_id": "t2", "is_error": true, "content": "String not found" }]),
        ),
    ]);
    assert_eq!(
        s.turns[1].diff.as_ref().unwrap().patch,
        "@@ -1,1 +1,1 @@\n-x\n+y\n"
    );
    assert!(s.turns[3].diff.is_none());
    assert_eq!(
        s.turns[4].tool.as_ref().unwrap().status,
        Some(ToolStatus::Error)
    );
}

#[test]
fn tool_result_blocks_and_images() {
    let s = one(vec![
        user(
            "2026-11-26T08:00:00Z",
            json!([{ "type": "text", "text": "xem ảnh này" }, { "type": "image", "source": {} }, { "type": "image", "source": {} }]),
        ),
        user(
            "2026-11-26T08:00:01Z",
            json!([{ "type": "tool_result", "tool_use_id": "không-có", "content": [
                { "type": "text", "text": "dòng 1" }, { "type": "text", "text": "dòng 2" }, { "type": "image", "source": {} }
            ] }]),
        ),
    ]);
    assert_eq!(s.turns[0].attachments[0].count, 2);
    assert_eq!(s.turns[0].text.as_deref(), Some("xem ảnh này"));
    let res = &s.turns[1];
    assert_eq!(res.tool.as_ref().unwrap().name, "unknown");
    assert_eq!(res.output.as_ref().unwrap().text, "dòng 1\ndòng 2");
    assert_eq!(res.attachments[0].count, 1);
}

#[test]
fn meta_sidechain_synthetic_and_harness_lines_are_skipped() {
    let mut meta = user(
        "2026-11-26T08:00:01Z",
        json!("Base directory for this skill: ..."),
    );
    meta["isMeta"] = json!(true);
    let mut side = assistant(
        "2026-11-26T08:00:02Z",
        "m0",
        json!([{ "type": "text", "text": "subagent" }]),
    );
    side["isSidechain"] = json!(true);
    let mut synthetic = assistant(
        "2026-11-26T08:00:03Z",
        "m9",
        json!([{ "type": "text", "text": "No response requested." }]),
    );
    synthetic["message"]["model"] = json!("<synthetic>");
    let mut notification = user(
        "2026-11-26T08:00:05Z",
        json!("<task-notification>xong</task-notification>"),
    );
    notification["origin"] = json!({ "kind": "task-notification" });
    let s = one(vec![
        user(
            "2026-11-26T08:00:00Z",
            json!("<command-name>/clear</command-name>"),
        ),
        meta,
        side,
        synthetic,
        user(
            "2026-11-26T08:00:04Z",
            json!("<local-command-stdout>đã xóa</local-command-stdout>"),
        ),
        notification,
    ]);
    assert_eq!(s.parse_warnings, 0);
    assert_eq!(s.turns.len(), 2);
    assert_eq!(s.turns[0].role, Role::User);
    assert_eq!(s.turns[1].role, Role::System);
    assert_eq!(s.turns[1].kind, TurnKind::Prompt);
}

#[test]
fn session_metadata() {
    let mut late = user("2026-11-26T09:00:00+07:00", json!("b"));
    late["cwd"] = json!("C:\\repo\\sub");
    late["gitBranch"] = json!("feat/x");
    let s = one(vec![user("2026-11-26T01:00:00Z", json!("a")), late]);
    assert_eq!(s.cwd.as_deref(), Some(std::path::Path::new("C:\\repo")));
    assert_eq!(s.session.source_id, format!("claude_code:{SID}"));
    assert_eq!(s.session.agent_version.as_deref(), Some("2.1.332"));
    assert_eq!(s.session.branch.as_deref(), Some("main"));
    assert_eq!(s.session.repo_remote, "");
    assert_eq!(s.session.cwd_relative, None);
    assert_eq!(s.session.parent_source_id, None);
    assert_eq!(
        s.session.started_at.to_rfc3339(),
        "2026-11-26T01:00:00+00:00"
    );
    assert_eq!(
        s.session.ended_at.unwrap().to_rfc3339(),
        "2026-11-26T02:00:00+00:00"
    );
    assert_eq!(s.turns.iter().map(|t| t.seq).collect::<Vec<_>>(), [0, 1]);

    let mut detached = user("2026-11-26T01:00:00Z", json!("a"));
    detached["gitBranch"] = json!("HEAD");
    assert_eq!(one(vec![detached]).session.branch, None);
}

#[test]
fn groups_by_session_id_and_drops_empty_sessions() {
    let mut other = user("2026-11-26T08:00:00Z", json!("phiên khác"));
    other["sessionId"] = json!("other");
    let events = ev(vec![
        user("2026-11-26T08:00:00Z", json!("a")),
        other,
        json!({ "type": "mode", "sessionId": "empty" }),
    ]);
    let sessions = ClaudeCodeAdapter::new("unused").normalize(events);
    let ids: Vec<_> = sessions
        .iter()
        .map(|s| s.session.source_id.as_str())
        .collect();
    assert_eq!(
        ids,
        [format!("claude_code:{SID}").as_str(), "claude_code:other"]
    );
}

#[test]
fn discover_lists_only_top_level_transcripts() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("projects").join("C--repo");
    std::fs::create_dir_all(project.join("abc").join("subagents")).unwrap();
    std::fs::write(project.join("b.jsonl"), "{}\n").unwrap();
    std::fs::write(project.join("a.jsonl"), "").unwrap();
    std::fs::write(project.join("notes.txt"), "").unwrap();
    std::fs::write(
        project.join("abc").join("subagents").join("agent-1.jsonl"),
        "",
    )
    .unwrap();
    std::fs::write(dir.path().join("projects").join("stray.jsonl"), "").unwrap();

    let adapter = ClaudeCodeAdapter::new(dir.path());
    let found = adapter.discover();
    let names: Vec<_> = found
        .iter()
        .map(|f| f.path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["a.jsonl", "b.jsonl"]);
    assert_eq!(found[1].size, 3);
    assert_eq!(found[1].agent, AgentKind::ClaudeCode);

    assert!(ClaudeCodeAdapter::new(dir.path().join("không-có"))
        .discover()
        .is_empty());
}

#[test]
fn read_incremental_reads_whole_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    std::fs::write(&path, "{\"type\":\"mode\"}\nnot json\n").unwrap();
    let adapter = ClaudeCodeAdapter::new(dir.path());
    let file = SourceFile {
        agent: AgentKind::ClaudeCode,
        path: path.clone(),
        size: 0,
        modified: None,
    };
    let (events, next) = adapter.read_incremental(&file, Offset(0)).unwrap();
    assert_eq!(events.len(), 2);
    assert!(events[1].is_unparsed());
    assert_eq!(next, Offset(25));

    let missing = SourceFile {
        path: dir.path().join("mất.jsonl"),
        ..file
    };
    assert!(matches!(
        adapter.read_incremental(&missing, Offset(0)),
        Err(ParseError::Io { .. })
    ));
}
