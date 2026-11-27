//! Kiểu request/response của `/agent/v1` (JSON camelCase, riêng `AgentConfig` và heartbeat snake_case; viết tay khớp `packages/schema/openapi`).

use serde::{Deserialize, Serialize};

/// Văn bản đồng ý của server (`ConsentText`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentText {
    /// Phiên bản văn bản; gửi lại đúng giá trị này khi `join`.
    pub version: String,
    pub text: String,
}

/// Project trong `InvitePreview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteProject {
    pub id: String,
    pub name: String,
    pub slug: String,
}

/// Trả về `200` của `GET /agent/v1/invites/{code}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreview {
    /// `TEAMLENS_PUBLIC_URL` của server.
    pub server_url: String,
    pub project: InviteProject,
    /// Repo sẽ được thu thập; session ngoài các repo này không bao giờ rời máy.
    pub repo_patterns: Vec<String>,
    pub consent: ConsentText,
    pub expires_at: String,
}

/// Phần đồng ý trong body `POST /agent/v1/join`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinConsent {
    /// Phải bằng `consent.version` của server, sai thì `409 consent_outdated`.
    pub text_version: String,
    /// Có gửi cả session cũ trên máy không.
    pub backfill: bool,
}

/// Body `POST /agent/v1/join`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequest {
    pub code: String,
    /// Tên hiển thị (server bỏ qua khi máy đã có token).
    pub name: String,
    pub device_name: String,
    pub os: String,
    pub cli_version: String,
    pub consent: JoinConsent,
}

// Mã mời là bí mật: không in ra log debug.
impl std::fmt::Debug for JoinRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JoinRequest")
            .field("code", &"<ẩn>")
            .field("name", &self.name)
            .field("device_name", &self.device_name)
            .field("os", &self.os)
            .field("cli_version", &self.cli_version)
            .field("consent", &self.consent)
            .finish()
    }
}

/// Project trong `JoinResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinProject {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub repo_patterns: Vec<String>,
}

/// Trả về `201`/`200` của `POST /agent/v1/join`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinResult {
    /// Device token `tld_...`; chỉ có khi máy mới tham gia (`201`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    pub user_id: String,
    pub device_id: String,
    /// Vai trò toàn server: `leader` hoặc `member`.
    pub role: String,
    pub project: JoinProject,
}

// Không in token ra log debug.
impl std::fmt::Debug for JoinResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JoinResult")
            .field("access_token", &self.access_token.as_ref().map(|_| "<ẩn>"))
            .field("user_id", &self.user_id)
            .field("device_id", &self.device_id)
            .field("role", &self.role)
            .field("project", &self.project)
            .finish()
    }
}

/// Trả về `200` của `POST /agent/v1/web-login`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebLoginResponse {
    /// `${TEAMLENS_PUBLIC_URL}/auth/cli?ticket=<ticket>`, dùng một lần.
    pub url: String,
    /// Số giây link còn hiệu lực (60).
    pub expires_in: u64,
}

// Link chứa ticket đăng nhập: không in ra log debug.
impl std::fmt::Debug for WebLoginResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebLoginResponse")
            .field("url", &"<ẩn>")
            .field("expires_in", &self.expires_in)
            .finish()
    }
}

/// Trả về của `GET /agent/v1/whoami`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoamiResponse {
    pub user: WhoamiUser,
    /// Vai trò toàn server: `leader` hoặc `member`.
    #[serde(default = "default_role")]
    pub role: String,
    pub device: WhoamiDevice,
    pub projects: Vec<WhoamiProject>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoamiUser {
    pub id: String,
    /// Chỉ leader có email; member tham gia bằng `tl join` thì `null`.
    #[serde(default)]
    pub email: Option<String>,
    pub name: String,
}

impl WhoamiUser {
    /// Tên hiển thị: `Tên <email>` nếu có email, không thì chỉ tên.
    pub fn display(&self) -> String {
        match &self.email {
            Some(email) => format!("{} <{email}>", self.name),
            None => self.name.clone(),
        }
    }
}

fn default_role() -> String {
    "member".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoamiDevice {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoamiProject {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub repo_patterns: Vec<String>,
}

/// Thân lỗi chuẩn của API: `{ "error": "<mã>", "message": "<mô tả>" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: String,
    #[serde(default)]
    pub message: String,
}

/// Trả về `202` của `POST /agent/v1/ingest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestResult {
    pub batch_id: String,
    /// `true` khi batch đã được nhận trước đó (kết quả là của lần đầu).
    pub duplicate: bool,
    pub accepted: Vec<IngestAccepted>,
    pub rejected: Vec<IngestRejected>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestAccepted {
    pub source_id: String,
    /// Id session trên server (link dashboard).
    pub session_id: String,
    pub turns_upserted: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestRejected {
    pub source_id: String,
    /// `repo_not_in_project` hoặc `invalid_session`.
    pub error: String,
    pub message: String,
}

/// Thân lỗi `426` của ingest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedSchemaVersionBody {
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub min_cli_version: Option<String>,
    #[serde(default)]
    pub supported_schema_versions: Vec<u32>,
}

/// Trả về `200` của `GET /agent/v1/config` (M2.2). **JSON snake_case** (khác các REST khác).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Repo pattern của mọi project user là thành viên.
    pub repo_patterns: Vec<AgentRepoPattern>,
    /// Pattern che secret bổ sung do leader cấu hình (M2.1 nối vào `Redactor`).
    #[serde(default)]
    pub redaction_patterns: Vec<AgentRedactionPattern>,
    /// Ngưỡng cắt; trường thiếu dùng mặc định spec 6.3.
    #[serde(default)]
    pub truncation: AgentTruncation,
    /// Phiên bản văn bản đồng ý hiện hành.
    pub consent_text_version: String,
    /// Phiên bản `tl` tối thiểu (`x.y.z`).
    pub min_cli_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRepoPattern {
    pub project_id: String,
    pub pattern: String,
}

/// Pattern che secret của server: đoạn khớp `regex` (cú pháp crate `regex`) thay bằng
/// `[REDACTED:<id>]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRedactionPattern {
    pub id: String,
    pub regex: String,
}

/// Ngưỡng cắt (byte UTF-8) trong `GET /agent/v1/config`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentTruncation {
    pub tool_input_bytes: u64,
    pub output_head_bytes: u64,
    pub output_tail_bytes: u64,
    pub diff_bytes: u64,
    pub thinking_bytes: u64,
}

impl Default for AgentTruncation {
    fn default() -> Self {
        let d = tl_core::truncate::TruncateLimits::default();
        Self {
            tool_input_bytes: d.tool_input_max as u64,
            output_head_bytes: d.output_head as u64,
            output_tail_bytes: d.output_tail as u64,
            diff_bytes: d.diff_max as u64,
            thinking_bytes: d.thinking_max as u64,
        }
    }
}

impl From<AgentTruncation> for tl_core::truncate::TruncateLimits {
    fn from(t: AgentTruncation) -> Self {
        let size = |v: u64| usize::try_from(v).unwrap_or(usize::MAX);
        Self {
            output_head: size(t.output_head_bytes),
            output_tail: size(t.output_tail_bytes),
            thinking_max: size(t.thinking_bytes),
            tool_input_max: size(t.tool_input_bytes),
            diff_max: size(t.diff_bytes),
        }
    }
}

/// Body `POST /agent/v1/heartbeat` (M3.3). **JSON snake_case** như `AgentConfig`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeartbeatRequest {
    /// `online` hoặc `paused`.
    pub status: DeviceRunStatus,
    pub cli_version: String,
    /// Agent phát hiện trên máy (mỗi loại một phần tử).
    pub agents: Vec<HeartbeatAgent>,
    /// Số lỗi parse đang ghi nhận trong `state.db`.
    pub parse_errors: u64,
    pub queue: HeartbeatQueue,
    /// Giờ máy lúc gửi (RFC 3339).
    pub sent_at: String,
}

/// Trạng thái thiết bị tự báo trong heartbeat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceRunStatus {
    Online,
    Paused,
}

impl DeviceRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Paused => "paused",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeartbeatAgent {
    /// `claude_code`, `codex`...
    pub agent: String,
    /// Phiên bản agent đọc được từ log gần nhất, `null` nếu chưa biết.
    pub version: Option<String>,
    /// Số file log tìm thấy.
    pub files: u64,
}

/// Hàng đợi gửi offline (M3.1).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeartbeatQueue {
    pub batches: u64,
    pub bytes: u64,
    pub dropped: u64,
    pub failed: u64,
}

/// Trả về `200` của `POST /agent/v1/heartbeat` (snake_case).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeartbeatResult {
    /// `online`, `paused` hoặc `consent_revoked` (đã rút đồng ý trên server).
    pub status: String,
    pub consent_text_version: String,
    pub min_cli_version: String,
}

/// Trạng thái đồng ý của một thiết bị so với văn bản hiện hành (`ConsentState` trong contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceConsentState {
    /// Có bản đồng ý chưa rút, đúng phiên bản hiện hành.
    Granted,
    /// Chỉ có bản đồng ý chưa rút ở phiên bản cũ.
    Outdated,
    /// Đã rút đồng ý và chưa đồng ý lại.
    Revoked,
    /// Chưa từng có bản đồng ý nào.
    None,
}

/// Trả về `200` của `GET` và `POST /agent/v1/consent` (JSON camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentStatus {
    /// Phiên bản văn bản đồng ý hiện hành của server.
    pub text_version: String,
    /// Văn bản đồng ý hiện hành.
    pub text: String,
    pub status: DeviceConsentState,
    /// Phiên bản thiết bị đã đồng ý (bản chưa rút mới nhất), nếu có.
    #[serde(default)]
    pub accepted_version: Option<String>,
    /// Lựa chọn gửi lịch sử cũ của bản đồng ý đó, nếu có.
    #[serde(default)]
    pub backfill: Option<bool>,
    #[serde(default)]
    pub granted_at: Option<String>,
    /// Lần rút đồng ý gần nhất khi `status` là `revoked`.
    #[serde(default)]
    pub revoked_at: Option<String>,
}

/// Body `POST /agent/v1/consent`: đồng ý lại hoặc rút đồng ý.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "action",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ConsentUpdate {
    /// Đồng ý lại; `text_version` phải bằng phiên bản hiện hành, sai thì `409 consent_outdated`.
    Grant {
        text_version: String,
        backfill: bool,
    },
    /// Rút đồng ý.
    Revoke,
}

#[cfg(test)]
mod consent_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn consent_update_serialize_dung_contract() {
        let grant = ConsentUpdate::Grant {
            text_version: "2026-11-27.2".into(),
            backfill: true,
        };
        assert_eq!(
            serde_json::to_value(&grant).unwrap(),
            json!({ "action": "grant", "textVersion": "2026-11-27.2", "backfill": true })
        );
        assert_eq!(
            serde_json::to_value(&ConsentUpdate::Revoke).unwrap(),
            json!({ "action": "revoke" })
        );
    }

    #[test]
    fn consent_status_doc_duoc_moi_trang_thai() {
        for (raw, expected) in [
            ("granted", DeviceConsentState::Granted),
            ("outdated", DeviceConsentState::Outdated),
            ("revoked", DeviceConsentState::Revoked),
            ("none", DeviceConsentState::None),
        ] {
            let status: ConsentStatus = serde_json::from_value(json!({
                "textVersion": "v2",
                "text": "Văn bản",
                "status": raw,
                "acceptedVersion": null,
                "backfill": null,
                "grantedAt": null,
                "revokedAt": null
            }))
            .unwrap();
            assert_eq!(status.status, expected);
            assert_eq!(status.accepted_version, None);
        }
    }

    #[test]
    fn consent_status_co_day_du_truong() {
        let status: ConsentStatus = serde_json::from_value(json!({
            "textVersion": "v2",
            "text": "Văn bản",
            "status": "outdated",
            "acceptedVersion": "v1",
            "backfill": false,
            "grantedAt": "2026-11-26T08:00:00.000Z",
            "revokedAt": null
        }))
        .unwrap();
        assert_eq!(status.accepted_version.as_deref(), Some("v1"));
        assert_eq!(status.backfill, Some(false));
        assert_eq!(
            status.granted_at.as_deref(),
            Some("2026-11-26T08:00:00.000Z")
        );
    }
}
