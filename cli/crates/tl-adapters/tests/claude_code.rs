//! Snapshot test adapter Claude Code trên log thật đã che (`tests/fixtures/claude_code/`).
//!
//! Mỗi fixture: đọc file → `normalize` → so JSON với snapshot (`tests/snapshots/`), rồi
//! dựng `SessionEnvelope` như pipeline sẽ làm (điền `repo_remote`, đổi `diff.path` sang
//! tương đối) và kiểm tra với `packages/schema/session.v1.schema.json`.
//!
//! Cập nhật snapshot sau khi sửa adapter có chủ đích: `cargo insta review`, hoặc chạy
//! test với `INSTA_UPDATE=always` rồi xem lại diff trong git.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tl_adapters::claude_code::ClaudeCodeAdapter;
use tl_adapters::{Adapter, AgentKind, NormalizedSession, Offset, SourceFile};
use tl_core::paths::PathContext;
use tl_core::session::{IngestBatch, PermissionMode, SessionEnvelope, TurnKind};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude_code")
}

fn load(rel: &str) -> NormalizedSession {
    let path = fixture_dir().join(rel);
    let adapter = ClaudeCodeAdapter::new(fixture_dir());
    let file = SourceFile {
        agent: AgentKind::ClaudeCode,
        size: std::fs::metadata(&path).unwrap().len(),
        path,
        modified: None,
    };
    let (events, next) = adapter.read_incremental(&file, Offset(0)).unwrap();
    assert_eq!(next.0, file.size, "{rel}: phải đọc hết file");
    let mut sessions = adapter.normalize(events);
    assert_eq!(sessions.len(), 1, "{rel}: mỗi fixture là một session");
    let session = sessions.remove(0);
    assert_schema_valid(&session, rel);
    session
}

/// Mô phỏng phần tối thiểu của pipeline M1.7 rồi kiểm tra với JSON Schema v1.
fn assert_schema_valid(normalized: &NormalizedSession, label: &str) {
    let cwd = normalized.cwd.as_ref().expect("fixture có cwd");
    let ctx = PathContext::new(cwd.to_str(), Some(r"C:\Users\dev"));
    let mut envelope = SessionEnvelope {
        session: normalized.session.clone(),
        turns: normalized.turns.clone(),
    };
    envelope.session.repo_remote = "github.com/acme/demo".into();
    envelope.session.cwd_relative = Some(String::new());
    for turn in &mut envelope.turns {
        if let Some(diff) = turn.diff.as_mut() {
            diff.path = ctx.relativize_path(&diff.path);
        }
    }
    let batch = IngestBatch::new(uuid::Uuid::nil(), vec![envelope]);
    let schema_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/schema/session.v1.schema.json");
    let schema: Value =
        serde_json::from_str(&std::fs::read_to_string(schema_path).unwrap()).unwrap();
    let validator = jsonschema::options()
        .should_validate_formats(true)
        .build(&schema)
        .unwrap();
    let value = serde_json::to_value(&batch).unwrap();
    let errors: Vec<String> = validator
        .iter_errors(&value)
        .map(|e| format!("{e} tại {}", e.instance_path()))
        .collect();
    assert!(errors.is_empty(), "{label} không hợp lệ: {errors:#?}");
}

fn count(s: &NormalizedSession, kind: TurnKind) -> usize {
    s.turns.iter().filter(|t| t.kind == kind).count()
}

#[test]
fn teamlens_worker_2_1_332() {
    let s = load("2.1.332/teamlens-worker.jsonl");
    assert_eq!(s.parse_warnings, 0);
    assert_eq!(s.session.agent_version.as_deref(), Some("2.1.332"));
    assert_eq!(s.session.permission_mode, Some(PermissionMode::Bypass));
    assert_eq!(s.session.branch.as_deref(), Some("MakitJenamin/m1-2"));
    // Tool call và result khớp cặp; Write cập nhật file có diff từ structuredPatch.
    assert_eq!(
        count(&s, TurnKind::ToolCall),
        count(&s, TurnKind::ToolResult)
    );
    let diffs: Vec<_> = s.turns.iter().filter_map(|t| t.diff.as_ref()).collect();
    assert_eq!(diffs.len(), 1);
    assert!(diffs[0].path.ends_with(r"tl-core\src\session.rs"));
    // Monitor gọi sai schema → tool_result lỗi.
    assert!(s.turns.iter().any(|t| t.tool.as_ref().is_some_and(
        |x| x.name == "Monitor" && x.status == Some(tl_core::session::ToolStatus::Error)
    )));
    insta::assert_json_snapshot!(s);
}

#[test]
fn rejected_tool_interrupt_2_1_326() {
    let s = load("2.1.326/rejected-tool-interrupt.jsonl");
    assert_eq!(s.parse_warnings, 0);
    // permissionMode `auto` không có trong schema → unknown.
    assert_eq!(s.session.permission_mode, Some(PermissionMode::Unknown));
    assert_eq!(s.session.branch.as_deref(), Some("main"));
    let interrupted: Vec<_> = s
        .turns
        .iter()
        .filter(|t| t.interrupted == Some(true))
        .collect();
    assert_eq!(interrupted.len(), 1);
    assert_eq!(interrupted[0].kind, TurnKind::ToolCall);
    insta::assert_json_snapshot!(s);
}

#[test]
fn subagent_compaction_2_1_322() {
    let parent = load("2.1.322/subagent-compaction.jsonl");
    let child = load("2.1.322/subagent-compaction/subagents/agent-ac4847d3842e4829c.jsonl");
    assert_eq!(parent.parse_warnings, 0);
    assert_eq!(child.parse_warnings, 0);

    // Session cha: gốc, bypass, có 1 lần ngắt và 1 compaction.
    let parent_id = "claude_code:24d35887-bc08-4a6e-9e7d-70dceaa07905";
    assert_eq!(parent.session.source_id, parent_id);
    assert_eq!(parent.session.parent_source_id, None);
    assert_eq!(parent.session.permission_mode, Some(PermissionMode::Bypass));
    assert_eq!(
        parent
            .turns
            .iter()
            .filter(|t| t.interrupted == Some(true))
            .count(),
        1
    );
    let compactions: Vec<_> = parent
        .turns
        .iter()
        .filter(|t| t.kind == TurnKind::Compaction)
        .collect();
    assert_eq!(compactions.len(), 1);
    assert_eq!(compactions[0].role, tl_core::session::Role::System);
    // Agent tool gọi subagent nằm trong session cha.
    assert!(parent
        .turns
        .iter()
        .any(|t| t.tool.as_ref().is_some_and(|x| x.name == "Agent")));

    // Session con: id riêng, trỏ về cha, không có permissionMode trong transcript.
    assert_eq!(
        child.session.source_id,
        format!("{parent_id}:ac4847d3842e4829c")
    );
    assert_eq!(child.session.parent_source_id.as_deref(), Some(parent_id));
    assert_eq!(child.session.permission_mode, None);
    assert_eq!(child.turns[0].kind, TurnKind::Prompt);
    insta::assert_json_snapshot!("subagent_compaction_parent_2_1_322", parent);
    insta::assert_json_snapshot!("subagent_compaction_child_2_1_322", child);
}

#[test]
fn accept_edits_interrupt_2_1_219() {
    let s = load("2.1.219/accept-edits-interrupt.jsonl");
    assert_eq!(s.parse_warnings, 0);
    assert_eq!(s.session.agent_version.as_deref(), Some("2.1.219"));
    assert_eq!(s.session.permission_mode, Some(PermissionMode::AcceptEdits));
    // Ngắt ngay sau một tool_result: turn assistant cuối (tool_call Write) bị đánh dấu.
    let last_assistant = s.turns.iter().rev().find(|t| t.model.is_some()).unwrap();
    assert_eq!(last_assistant.interrupted, Some(true));
    assert_eq!(last_assistant.kind, TurnKind::ToolCall);
    assert_eq!(s.session.branch, None, "gitBranch = HEAD là detached");
    // Write tạo mới và Write ghi đè đều có diff.
    let diffs = s.turns.iter().filter(|t| t.diff.is_some()).count();
    assert!(diffs >= 5, "chỉ có {diffs} diff");
    // Mỗi message.id chỉ một turn mang usage.
    let with_usage = s.turns.iter().filter(|t| t.usage.is_some()).count();
    let assistant_turns = s.turns.iter().filter(|t| t.model.is_some()).count();
    assert!(with_usage < assistant_turns);
    insta::assert_json_snapshot!(s);
}
