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
    pub device: WhoamiDevice,
    pub projects: Vec<WhoamiProject>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoamiUser {
    pub id: String,
    pub email: String,
    pub name: String,
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
    /// `leader` hoặc `member`.
    pub role: String,
    pub repo_patterns: Vec<String>,
}

/// Thân lỗi chuẩn của API: `{ "error": "<mã>", "message": "<mô tả>" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: String,
    #[serde(default)]
    pub message: String,
}
