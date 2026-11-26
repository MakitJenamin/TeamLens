//! Snapshot test adapter Codex trên log thật đã che (`tests/fixtures/codex/`).
//!
//! Mỗi fixture: đọc file → `normalize` → so JSON với snapshot (`tests/snapshots/`), rồi
//! dựng `SessionEnvelope` như pipeline sẽ làm (điền `repo_remote`, đổi `diff.path` sang
//! tương đối) và kiểm tra với `packages/schema/session.v1.schema.json`.
//!
//! Cập nhật snapshot sau khi sửa adapter có chủ đích: `cargo insta review`, hoặc chạy
//! test với `INSTA_UPDATE=always` rồi xem lại diff trong git.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tl_adapters::codex::CodexAdapter;
use tl_adapters::{Adapter, AgentKind, NormalizedSession, Offset, SourceFile};
use tl_core::paths::PathContext;
use tl_core::session::{IngestBatch, PermissionMode, Role, SessionEnvelope, ToolStatus, TurnKind};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex")
}

fn load(rel: &str) -> NormalizedSession {
    let path = fixture_dir().join(rel);
    let adapter = CodexAdapter::new(fixture_dir());
    let file = SourceFile {
        agent: AgentKind::Codex,
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

/// Mô phỏng phần tối thiểu của pipeline rồi kiểm tra với JSON Schema v1.
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

/// (input + cache_read, output) cộng trên mọi turn.
fn usage_sum(s: &NormalizedSession) -> (u64, u64) {
    s.turns
        .iter()
        .filter_map(|t| t.usage.as_ref())
        .fold((0, 0), |(i, o), u| {
            (i + u.input + u.cache_read.unwrap_or(0), o + u.output)
        })
}

#[test]
fn fork_rollback_abort_compaction_0_142_0() {
    let s = load("0.142.0/fork-rollback-abort-compaction.jsonl");
    assert_eq!(s.parse_warnings, 0);
    assert_eq!(
        s.session.source_id,
        "codex:019efe2b-1883-7a42-be74-f32566e718ac"
    );
    assert_eq!(s.session.agent_version.as_deref(), Some("0.142.0"));
    assert_eq!(s.session.permission_mode, Some(PermissionMode::Bypass));
    assert_eq!(s.session.parent_source_id, None);
    // Phần chép từ session cha (dấu thời gian 09:45:07–08) bị bỏ hết.
    let first = s.turns.first().unwrap();
    assert_eq!(first.kind, TurnKind::Prompt);
    assert!(first.ts.to_rfc3339().as_str() >= "2026-06-25T09:46:00");
    // Token của phần chép (total 1 412 793 ở dòng 20) không bị đếm.
    let (input, output) = usage_sum(&s);
    assert!(
        input > 0 && input <= 19_158_691 - 1_412_793,
        "input = {input}"
    );
    assert!(output > 0 && output <= 78_657 - 12_361, "output = {output}");
    // Diff thật từ patch_apply_end.
    let diffs: Vec<_> = s.turns.iter().filter_map(|t| t.diff.as_ref()).collect();
    assert_eq!(diffs.len(), 2);
    assert!(diffs[0].path.ends_with(r"plans\2026-06-25-plan-a\file1.md"));
    assert!(diffs[0].patch.starts_with("@@ -15,3 +15,3 @@"));
    // turn_aborted: lệnh shell đang chạy dở bị đánh dấu.
    let interrupted: Vec<_> = s
        .turns
        .iter()
        .filter(|t| t.interrupted == Some(true))
        .collect();
    assert_eq!(interrupted.len(), 1);
    assert_eq!(interrupted[0].kind, TurnKind::ToolCall);
    assert_eq!(count(&s, TurnKind::Compaction), 1);
    // Mọi turn assistant có model + reasoning_effort.
    assert!(s
        .turns
        .iter()
        .filter(|t| t.role == Role::Assistant)
        .all(|t| t.model == Some(Some("gpt-5.5".into()))
            && t.reasoning_effort.as_ref().is_some_and(Option::is_some)));
    insta::assert_json_snapshot!(s);
}

#[test]
fn ide_add_file_0_130_0_alpha_5() {
    let s = load("0.130.0-alpha.5/ide-add-file.jsonl");
    assert_eq!(s.parse_warnings, 0);
    assert_eq!(s.session.agent_version.as_deref(), Some("0.130.0-alpha.5"));
    // on-request + workspace-write.
    assert_eq!(s.session.permission_mode, Some(PermissionMode::Default));
    // `session_meta` lặp lại mỗi lượt (bản 0.130) không tách thành session khác; prompt
    // của extension VS Code đã bỏ phần ngữ cảnh IDE.
    let prompts: Vec<_> = s
        .turns
        .iter()
        .filter(|t| t.kind == TurnKind::Prompt)
        .collect();
    assert_eq!(prompts.len(), 4);
    assert!(prompts
        .iter()
        .all(|t| !t.text.as_deref().unwrap().contains("Context from my IDE")));
    // apply_patch tạo file mới: diff từ patch_apply_end, output dạng JSON cũ.
    let call = s
        .turns
        .iter()
        .find(|t| t.kind == TurnKind::ToolCall)
        .unwrap();
    assert_eq!(call.tool.as_ref().unwrap().name, "apply_patch");
    assert_eq!(call.tool.as_ref().unwrap().status, Some(ToolStatus::Ok));
    let diff = call.diff.as_ref().unwrap();
    assert!(diff.path.ends_with(r"demo-app\file1.md"));
    assert_eq!((diff.added, diff.removed), (5, 0));
    // token_count lặp (cùng total) chỉ đếm một lần: tổng bằng total cuối.
    assert_eq!(usage_sum(&s), (108_062, 318));
    insta::assert_json_snapshot!(s);
}

#[test]
fn exec_script_error_0_142_0_alpha_1() {
    let s = load("0.142.0-alpha.1/exec-script-error.jsonl");
    assert_eq!(s.parse_warnings, 0);
    assert_eq!(
        count(&s, TurnKind::ToolCall),
        count(&s, TurnKind::ToolResult)
    );
    // Output dạng mảng `input_text` bắt đầu bằng "Script failed" → lỗi.
    let errors = s
        .turns
        .iter()
        .filter(|t| {
            t.kind == TurnKind::ToolCall
                && t.tool.as_ref().unwrap().status == Some(ToolStatus::Error)
        })
        .count();
    assert_eq!(errors, 3);
    assert_eq!(usage_sum(&s), (251_886, 999));
    insta::assert_json_snapshot!(s);
}

#[test]
fn teamlens_exec_list_cli_0_172_0() {
    let s = load("0.172.0/teamlens-exec-list-cli.jsonl");
    // `token_usage_record`, `additional_tools`, `item_completed` của bản mới không là cảnh báo.
    assert_eq!(s.parse_warnings, 0);
    assert_eq!(s.session.agent_version.as_deref(), Some("0.172.0"));
    // Bản 0.172 không còn event `user_message`: prompt lấy từ `item_completed`.
    assert_eq!(count(&s, TurnKind::Prompt), 1);
    assert_eq!(s.turns[0].kind, TurnKind::Prompt);
    assert_eq!(
        count(&s, TurnKind::ToolCall),
        count(&s, TurnKind::ToolResult)
    );
    assert!(s
        .turns
        .iter()
        .filter(|t| t.role == Role::Assistant)
        .all(|t| t.reasoning_effort == Some(Some("medium".into()))));
    assert_eq!(usage_sum(&s), (179_993, 1_989));
    insta::assert_json_snapshot!(s);
}
