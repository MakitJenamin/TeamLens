//! Kiểu request/response của `/agent/v1` (JSON camelCase, khớp contract giai đoạn nền).

use serde::{Deserialize, Serialize};

/// Body `POST /agent/v1/device/code`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeRequest {
    pub device_name: String,
    pub os: String,
    pub cli_version: String,
}

/// Trả về của `POST /agent/v1/device/code`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    /// Số giây mã còn hiệu lực (900).
    pub expires_in: u64,
    /// Số giây tối thiểu giữa hai lần poll (5).
    pub interval: u64,
}

/// Body `POST /agent/v1/device/token`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTokenRequest {
    pub device_code: String,
}

/// Trả về 200 của `POST /agent/v1/device/token` (chỉ trả một lần).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTokenResponse {
    pub access_token: String,
    pub device_id: String,
}

// Không in token ra log debug.
impl std::fmt::Debug for DeviceTokenResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceTokenResponse")
            .field("access_token", &"<ẩn>")
            .field("device_id", &self.device_id)
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
