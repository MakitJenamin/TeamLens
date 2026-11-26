//! Kiểu request/response của `/agent/v1` (JSON camelCase, viết tay khớp `packages/schema/openapi`).

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
