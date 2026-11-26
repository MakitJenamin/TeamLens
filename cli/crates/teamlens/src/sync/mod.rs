//! Gửi session lên `POST /agent/v1/ingest` và phần dùng chung của `tl sync`/`tl preview`.
//! Task M1.7.
//!
//! Gửi thật nằm ở hàng đợi [`crate::queue`] (M3.1): `tl sync` xếp hàng rồi flush; daemon
//! (M3.2) gọi lại đúng các hàm đó.

pub mod agent_config;
pub mod consent_gate;
pub mod incremental;
pub mod scan;

use tl_adapters::claude_code::ClaudeCodeAdapter;
use tl_adapters::codex::CodexAdapter;
use tl_adapters::Adapter;

use crate::api_client::{ApiClient, ApiError, ApiErrorCode, IngestError};
use crate::context::AppContext;
use crate::error::AppError;
use crate::pipeline::prepare::PrepareOptions;

/// Nguồn log và tùy chọn xử lý của máy; test thay bằng thư mục tạm.
pub struct Sources {
    pub adapters: Vec<Box<dyn Adapter>>,
    pub prepare: PrepareOptions,
}

impl Sources {
    /// Adapter thật của máy: Claude Code và Codex.
    pub fn from_env() -> Self {
        let mut adapters: Vec<Box<dyn Adapter>> = Vec::new();
        if let Some(cc) = ClaudeCodeAdapter::from_env() {
            adapters.push(Box::new(cc));
        }
        if let Some(codex) = CodexAdapter::from_env() {
            adapters.push(Box::new(codex));
        }
        Self {
            adapters,
            prepare: PrepareOptions::from_env(),
        }
    }

    pub fn adapter_refs(&self) -> Vec<&dyn Adapter> {
        self.adapters.iter().map(|a| a.as_ref()).collect()
    }
}

/// Đã đăng nhập: client có token, địa chỉ server và cấu hình từ server (M2.2).
pub struct Connected {
    pub server_url: String,
    pub client: ApiClient,
    /// Config từ `GET /agent/v1/config` (hoặc bản cache khi mất mạng).
    pub agent_config: agent_config::LoadedConfig,
}

/// Đọc config + token rồi tải `GET /agent/v1/config` (repo pattern, ngưỡng cắt, phiên bản).
/// Mất mạng thì dùng bản cache gần nhất của cùng server; không có cache thì lỗi.
/// Lỗi có gợi ý tiếng Việt.
pub async fn connect(ctx: &AppContext) -> Result<Connected, AppError> {
    let config = ctx.load_config()?;
    let not_logged_in = || {
        AppError::user(
            "Máy này chưa đăng nhập TeamLens.",
            "Chạy `tl join <link mời>` (link do leader gửi) trước.",
        )
    };
    let server_url = config.server_url.ok_or_else(not_logged_in)?;
    let token = ctx
        .credentials
        .get_token(&server_url)?
        .ok_or_else(not_logged_in)?;
    let client = ApiClient::new(&server_url, Some(token))?;
    let agent_config = agent_config::load(ctx, &client, &server_url)
        .await
        .map_err(login_hint)?;
    Ok(Connected {
        server_url,
        client,
        agent_config,
    })
}

/// 401 → lỗi kèm nhắc `tl join`.
fn login_hint(e: ApiError) -> AppError {
    if e.code().is_some_and(|c| {
        matches!(
            c,
            ApiErrorCode::InvalidToken | ApiErrorCode::Unauthenticated
        )
    }) || matches!(e, ApiError::Api { status: 401, .. })
    {
        return AppError::user(
            "Token của máy này không còn hiệu lực (đã hết hạn hoặc bị thu hồi).",
            "Chạy lại `tl join <link mời>` (xin leader link còn hạn) để tham gia lại.",
        );
    }
    AppError::Api(e)
}

/// Lỗi ingest → lỗi tiếng Việt cho người dùng (dùng chung với [`crate::queue`]).
pub(crate) fn ingest_app_error(e: IngestError) -> AppError {
    match e {
        IngestError::UpgradeRequired {
            min_cli_version,
            message,
        } => AppError::user(
            format!(
                "Server không nhận dữ liệu từ bản tl {} này{}.",
                crate::CLI_VERSION,
                if message.is_empty() {
                    String::new()
                } else {
                    format!(" ({message})")
                }
            ),
            match min_cli_version {
                Some(v) => format!("Cập nhật tl lên bản {v} trở lên rồi chạy lại `tl sync`."),
                None => "Cập nhật tl lên bản mới nhất rồi chạy lại `tl sync`.".to_owned(),
            },
        ),
        IngestError::RateLimited { .. } => AppError::user(
            "Server vẫn báo gửi quá nhanh sau khi đã chờ.",
            "Đợi vài phút rồi chạy lại `tl sync`.",
        ),
        IngestError::TooLarge => AppError::user(
            "Batch vượt giới hạn kích thước của server.",
            "Báo admin kiểm tra giới hạn body của server/proxy.",
        ),
        IngestError::Api(e) => {
            if e.code() == Some(&ApiErrorCode::Other("consent_required".into())) {
                return AppError::user(
                    "Thiết bị này chưa đồng ý (hoặc đã rút đồng ý) chia sẻ dữ liệu.",
                    "Chạy lại `tl join <link mời>` để xem và đồng ý.",
                );
            }
            login_hint(e)
        }
    }
}

/// Link dashboard của một session (`/projects/<project>/sessions/<id>`).
pub fn dashboard_link(server_url: &str, project_id: &str, session_id: &str) -> String {
    format!(
        "{}/projects/{project_id}/sessions/{session_id}",
        server_url.trim_end_matches('/')
    )
}
