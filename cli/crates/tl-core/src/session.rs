//! Kiểu dữ liệu session chuẩn hóa theo schema v1 (spec mục 5.3) — task M1.2.
//!
//! Struct `serde` viết tay, khớp `packages/schema/session.v1.schema.json`
//! (snake_case), kèm test so với các file trong `packages/schema/examples/`.
//!
//! Cây kiểu: [`IngestBatch`] → [`SessionEnvelope`] → [`Session`] + [`Turn`]
//! (→ [`Tool`], [`Output`], [`Diff`], [`Usage`], [`Attachment`], [`Redaction`]).
//!
//! Quy ước ánh xạ schema → Rust:
//!
//! - Trường **bắt buộc nhưng nhận `null`** (vd. `Session::agent_version`): `Option<T>`
//!   KHÔNG có `skip_serializing_if`, nên `None` ra `null`.
//! - Trường **không bắt buộc, không nhận `null`** (vd. `Turn::text`): `Option<T>` +
//!   `skip_serializing_if`, nên `None` là thiếu trường.
//! - Trường **không bắt buộc và nhận `null`** (`Turn::model`, `Turn::reasoning_effort`):
//!   `Option<Option<T>>` để phân biệt thiếu trường (`None`) với `null` (`Some(None)`),
//!   giữ round-trip đúng từng byte ngữ nghĩa.
//! - Mọi object có `additionalProperties: false` dùng `deny_unknown_fields`; riêng
//!   `tool.input` là object tự do (`serde_json::Map`).
//!
//! Thời gian dùng `chrono::DateTime<Utc>` thay vì `String`: kiểu đảm bảo luôn là
//! RFC 3339 hợp lệ (`format: date-time`), so sánh/sắp xếp được (M1.7 cần), và serde của
//! chrono in dạng `2026-11-26T09:00:00Z` (phần lẻ giây chỉ in khi khác 0), trùng với
//! dạng log của agent và dạng trong `examples/`. Adapter đọc timestamp có offset khác
//! (vd. `+07:00`) sẽ được quy về UTC khi parse.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;

use crate::redact::RedactionCount;

/// Phiên bản schema session mà CLI này gửi (`IngestBatch.schema_version`).
/// Server trả 426 nếu không hỗ trợ.
pub const SCHEMA_VERSION: u32 = 1;

/// Session đã chuẩn hóa, đầu ra của `Adapter::normalize` (chốt ở task M1.3).
///
/// Đây là dữ liệu **thô trong RAM**: adapter chỉ đổi định dạng log gốc sang kiểu của
/// schema v1, KHÔNG lọc phạm vi, KHÔNG che secret, KHÔNG cắt, KHÔNG đổi đường dẫn.
/// Kiểu này không bao giờ được ghi ra đĩa hay gửi đi nguyên trạng.
///
/// Hợp đồng cho pipeline (task M1.7), theo thứ tự spec mục 6:
///
/// 1. **Lọc phạm vi** bằng [`Self::cwd`] (spec 6.1): `None` hoặc không thuộc repo đã
///    đăng ký → bỏ cả session. Khớp thì điền `session.repo_remote` (adapter để chuỗi
///    rỗng) và `session.cwd_relative` (adapter để `None`).
/// 2. **Che secret** ([`crate::redact`]) trên `text`, `tool.input`, `output.text`,
///    `diff.patch` của từng turn, ghi `redactions`.
/// 3. **Đổi đường dẫn** ([`crate::paths`]): `diff.path` đang là đường dẫn **tuyệt đối**
///    lấy nguyên từ log, phải đổi thành tương đối với gốc repo; text, input, output
///    cũng còn đường dẫn tuyệt đối.
/// 4. **Cắt** ([`crate::truncate`]): `output` đang là nguyên văn (`truncated = false`,
///    `original_bytes = None`), `tool.input` chưa cắt 4 KB, `diff.patch` chưa cắt 256 KB.
///
/// `session.ended_at` là timestamp của dòng hội thoại cuối cùng đã đọc; nếu file còn
/// đang được ghi (chưa "ổn định", task M2.3) thì pipeline nên đặt lại `None`.
///
/// `Serialize` chỉ để test snapshot và debug; payload gửi đi là [`SessionEnvelope`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NormalizedSession {
    /// Thư mục làm việc **tuyệt đối, chưa che** lúc bắt đầu session (spec 6.1 điểm 4:
    /// session đổi `cwd` giữa chừng vẫn xét theo `cwd` đầu tiên). `None` khi log không
    /// ghi `cwd`; pipeline phải bỏ session đó.
    pub cwd: Option<std::path::PathBuf>,
    /// Metadata; `repo_remote` rỗng và `cwd_relative = None` cho tới khi pipeline điền.
    pub session: Session,
    /// Các turn theo thứ tự trong log, `seq` liên tục từ 0.
    pub turns: Vec<Turn>,
    /// Số bản ghi hỏng hoặc không nhận ra đã bỏ qua (spec 5.2).
    pub parse_warnings: u32,
}

/// Một batch gửi tới `POST /agent/v1/ingest`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IngestBatch {
    /// Luôn là [`SCHEMA_VERSION`] khi CLI tạo batch.
    pub schema_version: u32,
    /// UUID do CLI sinh; server dùng để chống trùng khi gửi lại.
    pub batch_id: Uuid,
    /// Các session trong batch; schema yêu cầu ít nhất một phần tử.
    pub sessions: Vec<SessionEnvelope>,
}

impl IngestBatch {
    /// Tạo batch với `schema_version` = [`SCHEMA_VERSION`].
    pub fn new(batch_id: Uuid, sessions: Vec<SessionEnvelope>) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            batch_id,
            sessions,
        }
    }
}

/// Một session cùng các turn mới (gửi tăng dần, server upsert theo `seq`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionEnvelope {
    /// Metadata của session.
    pub session: Session,
    /// Các turn chưa gửi (có thể rỗng khi chỉ cập nhật metadata, vd. `ended_at`).
    pub turns: Vec<Turn>,
}

/// Loại agent. Giá trị serde trùng với trường `agent` trong schema v1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    /// Claude Code.
    ClaudeCode,
    /// Codex CLI.
    Codex,
    /// GitHub Copilot trong VS Code.
    CopilotVscode,
    /// Antigravity.
    Antigravity,
}

impl AgentKind {
    /// Chuỗi định danh dùng trong schema và `source_id` (ví dụ `claude_code`).
    pub fn as_str(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "claude_code",
            AgentKind::Codex => "codex",
            AgentKind::CopilotVscode => "copilot_vscode",
            AgentKind::Antigravity => "antigravity",
        }
    }

    /// Dựng `source_id` dạng `<agent>:<id gốc>`.
    pub fn source_id(self, raw_id: &str) -> String {
        format!("{}:{raw_id}", self.as_str())
    }
}

impl std::fmt::Display for AgentKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Metadata của một session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    /// `<agent>:<id gốc>` (xem [`AgentKind::source_id`]); tối đa 512 ký tự.
    pub source_id: String,
    /// Agent sinh ra session.
    pub agent: AgentKind,
    /// Phiên bản agent đọc được từ log (tối đa 64 ký tự); `None` → `null`.
    pub agent_version: Option<String>,
    /// Remote git đã chuẩn hóa dạng `host/org/repo` (xem [`crate::scope`]).
    pub repo_remote: String,
    /// Nhánh lúc bắt đầu; `None` → `null` khi detached HEAD hoặc không đọc được.
    pub branch: Option<String>,
    /// Thư mục làm việc tương đối gốc repo, dùng `/`; `""` là gốc repo. Không bao giờ
    /// là đường dẫn tuyệt đối (xem [`crate::paths`]).
    pub cwd_relative: Option<String>,
    /// Thời điểm bắt đầu.
    pub started_at: DateTime<Utc>,
    /// `None` → `null` khi session còn đang chạy.
    pub ended_at: Option<DateTime<Utc>>,
    /// `source_id` của session cha (subagent); `None` → `null` với session gốc.
    pub parent_source_id: Option<String>,
    /// Chế độ quyền; thiếu trường khi không đọc được.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    /// File hướng dẫn ở gốc repo (chỉ đường dẫn + kích thước, KHÔNG nội dung).
    /// `None`: CLI không thu thập; `Some(vec![])`: không có file nào.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction_files: Option<Vec<InstructionFile>>,
}

/// Chế độ quyền của agent trong session (dùng cho rule `yolo-mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Hỏi trước khi sửa file/chạy lệnh.
    Default,
    /// Tự chấp nhận sửa file.
    AcceptEdits,
    /// Chỉ lập kế hoạch.
    Plan,
    /// Bỏ qua mọi xác nhận.
    Bypass,
    /// Không xác định được.
    Unknown,
}

/// File hướng dẫn cho agent (`CLAUDE.md`, `AGENTS.md`, ...).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstructionFile {
    /// Đường dẫn tương đối với gốc repo, dùng `/`, không rỗng.
    pub path: String,
    /// Kích thước file (byte).
    pub bytes: u64,
}

/// Một lượt trong session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Turn {
    /// Số thứ tự trong session, bắt đầu từ 0.
    pub seq: u32,
    /// Ai nói.
    pub role: Role,
    /// Loại lượt.
    pub kind: TurnKind,
    /// Thời điểm của lượt.
    pub ts: DateTime<Utc>,
    /// Model sinh ra turn. `None`: thiếu trường; `Some(None)`: `null`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "double_option"
    )]
    pub model: Option<Option<String>>,
    /// Nội dung prompt/reply/tóm tắt compaction (đã che secret).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Tool được gọi (với `tool_call`/`tool_result`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<Tool>,
    /// Output của tool (đã cắt, xem [`crate::truncate`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Output>,
    /// Diff file do tool sửa.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<Diff>,
    /// Số token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// Đính kèm (chỉ đếm, không gửi nội dung). Rỗng thì không serialize.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    /// Số lần che secret theo loại. Rỗng thì không serialize.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub redactions: Vec<Redaction>,
    /// `Some(true)` khi người dùng ngắt lượt này.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
    /// Mức suy luận (tối đa 32 ký tự). `None`: thiếu trường; `Some(None)`: `null`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "double_option"
    )]
    pub reasoning_effort: Option<Option<String>>,
}

impl Turn {
    /// Turn tối thiểu, mọi trường tùy chọn để trống.
    pub fn new(seq: u32, role: Role, kind: TurnKind, ts: DateTime<Utc>) -> Self {
        Self {
            seq,
            role,
            kind,
            ts,
            model: None,
            text: None,
            tool: None,
            output: None,
            diff: None,
            usage: None,
            attachments: Vec::new(),
            redactions: Vec::new(),
            interrupted: None,
            reasoning_effort: None,
        }
    }
}

/// Vai trò của lượt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Người dùng (gồm cả kết quả tool trả về agent).
    User,
    /// Agent.
    Assistant,
    /// Hệ thống (ngữ cảnh môi trường, compaction).
    System,
}

/// Loại lượt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnKind {
    /// Prompt.
    Prompt,
    /// Câu trả lời.
    Reply,
    /// Agent gọi tool.
    ToolCall,
    /// Kết quả tool.
    ToolResult,
    /// Tóm tắt khi agent nén ngữ cảnh.
    Compaction,
}

/// Tool được gọi.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tool {
    /// Tên tool (không rỗng), vd. `Edit`, `Bash`, `apply_patch`.
    pub name: String,
    /// Input gốc (tùy agent, không kiểm tra cấu trúc); cắt khi quá 4 KB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Map<String, serde_json::Value>>,
    /// Kết quả gọi tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ToolStatus>,
}

/// Kết quả gọi tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    /// Thành công.
    Ok,
    /// Lỗi.
    Error,
}

/// Output của tool sau khi cắt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Output {
    /// Nội dung (đã che, đã cắt).
    pub text: String,
    /// `true` khi chỉ giữ phần đầu và phần cuối.
    pub truncated: bool,
    /// Kích thước output gốc (byte) trước khi cắt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_bytes: Option<u64>,
}

/// Diff của một file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Diff {
    /// Đường dẫn tương đối với gốc repo.
    pub path: String,
    /// Unified diff, tối đa 256 KB.
    pub patch: String,
    /// Số dòng thêm.
    pub added: u32,
    /// Số dòng xóa.
    pub removed: u32,
}

/// Số token của một lượt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Usage {
    /// Token đầu vào.
    pub input: u64,
    /// Token đầu ra.
    pub output: u64,
    /// Token đọc từ cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    /// Token ghi vào cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
    /// `Some(true)` khi số token là ước tính (vd. Copilot).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated: Option<bool>,
}

/// Đính kèm của một lượt (chỉ đếm).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attachment {
    /// Loại đính kèm.
    #[serde(rename = "type")]
    pub kind: AttachmentKind,
    /// Số lượng (≥ 1).
    pub count: u32,
}

/// Loại đính kèm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    /// Ảnh.
    Image,
}

/// Số lần che một loại secret trong lượt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Redaction {
    /// Loại secret (`^[a-z0-9_]+$`), vd. `aws_access_key`.
    #[serde(rename = "type")]
    pub kind: String,
    /// Số vùng đã che (≥ 1).
    pub count: u32,
}

impl From<RedactionCount> for Redaction {
    fn from(c: RedactionCount) -> Self {
        Self {
            kind: c.kind,
            count: c.count,
        }
    }
}

impl From<&RedactionCount> for Redaction {
    fn from(c: &RedactionCount) -> Self {
        Self {
            kind: c.kind.clone(),
            count: c.count,
        }
    }
}

/// Đổi danh sách đếm của [`crate::redact`] sang `Turn::redactions`.
///
/// Thường dùng với [`crate::redact::merge_counts`] để gộp số lần che của text,
/// tool input và output trong cùng một turn.
pub fn redactions_from_counts(counts: impl IntoIterator<Item = RedactionCount>) -> Vec<Redaction> {
    counts.into_iter().map(Redaction::from).collect()
}

/// Deserialize trường có thể thiếu hoặc `null`: có mặt (kể cả `null`) → `Some(..)`;
/// thiếu → `None` nhờ `#[serde(default)]`.
fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use serde_json::{json, Value};

    use super::*;

    fn schema_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/schema")
    }

    fn validator() -> jsonschema::Validator {
        let path = schema_dir().join("session.v1.schema.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("không đọc được {}: {e}", path.display()));
        let schema: Value = serde_json::from_str(&text).unwrap();
        jsonschema::options()
            .should_validate_formats(true)
            .build(&schema)
            .expect("schema hợp lệ")
    }

    fn assert_valid(validator: &jsonschema::Validator, value: &Value, label: &str) {
        let errors: Vec<String> = validator
            .iter_errors(value)
            .map(|e| format!("{} tại {}", e, e.instance_path()))
            .collect();
        assert!(errors.is_empty(), "{label} không hợp lệ: {errors:#?}");
    }

    fn examples() -> Vec<(String, Value)> {
        let dir = schema_dir().join("examples");
        let mut out: Vec<(String, Value)> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("không đọc được {}: {e}", dir.display()))
            .map(|entry| entry.unwrap().path())
            .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
            .map(|p| {
                let text = std::fs::read_to_string(&p).unwrap();
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                (name, serde_json::from_str(&text).unwrap())
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    #[test]
    fn examples_round_trip_and_validate() {
        let validator = validator();
        let examples = examples();
        assert!(examples.len() >= 3, "thiếu file examples");
        for (name, original) in examples {
            assert_valid(&validator, &original, &format!("{name} (gốc)"));
            let batch: IngestBatch = serde_json::from_value(original.clone())
                .unwrap_or_else(|e| panic!("{name}: không deserialize được: {e}"));
            assert_eq!(batch.schema_version, SCHEMA_VERSION);
            let back = serde_json::to_value(&batch).unwrap();
            assert_eq!(back, original, "{name}: round-trip lệch");
            assert_valid(&validator, &back, &format!("{name} (serialize lại)"));
        }
    }

    fn sample_batch() -> IngestBatch {
        let ts: DateTime<Utc> = "2026-11-26T10:00:00Z".parse().unwrap();
        let mut prompt = Turn::new(0, Role::User, TurnKind::Prompt, ts);
        prompt.text = Some("sửa lỗi [REDACTED:github_token]".into());
        prompt.redactions = redactions_from_counts(vec![RedactionCount {
            kind: "github_token".into(),
            count: 1,
        }]);
        prompt.attachments = vec![Attachment {
            kind: AttachmentKind::Image,
            count: 2,
        }];

        let mut call = Turn::new(
            1,
            Role::Assistant,
            TurnKind::ToolCall,
            ts + chrono::Duration::milliseconds(1500),
        );
        call.model = Some(Some("claude-opus-5-5".into()));
        call.reasoning_effort = Some(None);
        call.interrupted = Some(false);
        let mut input = serde_json::Map::new();
        input.insert("file_path".into(), json!("src/lib.rs"));
        call.tool = Some(Tool {
            name: "Edit".into(),
            input: Some(input),
            status: Some(ToolStatus::Ok),
        });
        call.diff = Some(Diff {
            path: "src/lib.rs".into(),
            patch: "@@ -1 +1 @@\n-a\n+b\n".into(),
            added: 1,
            removed: 1,
        });
        call.usage = Some(Usage {
            input: 100,
            output: 20,
            cache_read: Some(0),
            cache_write: None,
            estimated: None,
        });

        let mut result = Turn::new(2, Role::User, TurnKind::ToolResult, ts);
        result.tool = Some(Tool {
            name: "Edit".into(),
            input: None,
            status: Some(ToolStatus::Error),
        });
        result.output = Some(Output {
            text: "lỗi".into(),
            truncated: true,
            original_bytes: Some(9000),
        });

        IngestBatch::new(
            Uuid::nil(),
            vec![SessionEnvelope {
                session: Session {
                    source_id: AgentKind::ClaudeCode.source_id("abc-123"),
                    agent: AgentKind::ClaudeCode,
                    agent_version: None,
                    repo_remote: "github.com/acme/shop-web".into(),
                    branch: None,
                    cwd_relative: Some("apps/web".into()),
                    started_at: ts,
                    ended_at: None,
                    parent_source_id: None,
                    permission_mode: Some(PermissionMode::AcceptEdits),
                    instruction_files: Some(vec![InstructionFile {
                        path: "CLAUDE.md".into(),
                        bytes: 120,
                    }]),
                },
                turns: vec![prompt, call, result],
            }],
        )
    }

    #[test]
    fn hand_built_batch_is_valid() {
        let batch = sample_batch();
        let value = serde_json::to_value(&batch).unwrap();
        assert_valid(&validator(), &value, "batch dựng tay");

        // Trường bắt buộc nhận null ra `null`; trường tùy chọn rỗng thì không có mặt.
        let session = &value["sessions"][0]["session"];
        assert_eq!(session["agent_version"], Value::Null);
        assert_eq!(session["ended_at"], Value::Null);
        let turns = &value["sessions"][0]["turns"];
        assert!(turns[0].get("model").is_none());
        assert!(turns[2].get("redactions").is_none());
        assert_eq!(turns[1]["reasoning_effort"], Value::Null);
        assert_eq!(turns[1]["ts"], "2026-11-26T10:00:01.500Z");
        assert_eq!(turns[0]["attachments"][0]["type"], "image");

        let back: IngestBatch = serde_json::from_value(value).unwrap();
        assert_eq!(back, batch);
    }

    #[test]
    fn minimal_batch_is_valid() {
        let ts: DateTime<Utc> = "2026-11-26T10:00:00Z".parse().unwrap();
        let batch = IngestBatch::new(
            Uuid::new_v4(),
            vec![SessionEnvelope {
                session: Session {
                    source_id: AgentKind::Codex.source_id("x"),
                    agent: AgentKind::Codex,
                    agent_version: Some("0.64.0".into()),
                    repo_remote: "gitlab.com/acme/billing".into(),
                    branch: Some("main".into()),
                    cwd_relative: Some(String::new()),
                    started_at: ts,
                    ended_at: Some(ts),
                    parent_source_id: Some(AgentKind::Codex.source_id("parent")),
                    permission_mode: None,
                    instruction_files: Some(Vec::new()),
                },
                turns: Vec::new(),
            }],
        );
        let value = serde_json::to_value(&batch).unwrap();
        assert_valid(&validator(), &value, "batch tối thiểu");
        assert_eq!(
            value["sessions"][0]["session"]["instruction_files"],
            json!([])
        );
    }

    #[test]
    fn rejects_unknown_fields() {
        let ts = "2026-11-26T10:00:00Z";
        let turn = json!({ "seq": 0, "role": "user", "kind": "prompt", "ts": ts, "extra": 1 });
        assert!(serde_json::from_value::<Turn>(turn).is_err());
        let usage = json!({ "input": 1, "output": 2, "reasoning": 3 });
        assert!(serde_json::from_value::<Usage>(usage).is_err());
        // tool.input là object tự do: nhận mọi khóa.
        let tool = json!({ "name": "x", "input": { "anything": { "nested": true } } });
        assert!(serde_json::from_value::<Tool>(tool).is_ok());
    }

    #[test]
    fn redaction_conversion() {
        let r: Redaction = RedactionCount {
            kind: "aws_access_key".into(),
            count: 3,
        }
        .into();
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({ "type": "aws_access_key", "count": 3 })
        );
    }

    #[test]
    fn agent_kind_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&AgentKind::CopilotVscode).unwrap(),
            "\"copilot_vscode\""
        );
        assert_eq!(AgentKind::ClaudeCode.source_id("abc"), "claude_code:abc");
        assert_eq!(
            serde_json::to_string(&PermissionMode::AcceptEdits).unwrap(),
            "\"accept_edits\""
        );
    }
}
