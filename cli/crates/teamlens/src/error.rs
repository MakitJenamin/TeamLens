//! Lỗi hiển thị cho người dùng.
//!
//! Quy ước: thông điệp tiếng Việt, ngắn, kèm gợi ý cách sửa ([`AppError::hint`]).
//! Không in stack trace trừ khi `TL_LOG=debug`.

use crate::api_client::{ApiError, ApiErrorCode};
use tl_platform::PlatformError;

/// Mã thoát khi lệnh chưa được làm.
pub const EXIT_NOT_IMPLEMENTED: u8 = 2;
/// Mã thoát cho lỗi thông thường.
pub const EXIT_FAILURE: u8 = 1;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// Lệnh còn là khung, thuộc task khác.
    #[error("Chưa làm: lệnh {command} thuộc task {task}")]
    NotImplemented {
        command: &'static str,
        task: &'static str,
    },

    /// Lỗi nghiệp vụ có sẵn thông điệp cho người dùng.
    #[error("{message}")]
    User {
        message: String,
        hint: Option<String>,
    },

    #[error(transparent)]
    Api(#[from] ApiError),

    #[error(transparent)]
    Platform(#[from] PlatformError),

    #[error("Không đọc/ghi được file cấu hình {path}: {detail}")]
    Config { path: String, detail: String },
}

impl AppError {
    pub fn user(message: impl Into<String>, hint: impl Into<String>) -> Self {
        AppError::User {
            message: message.into(),
            hint: Some(hint.into()),
        }
    }

    pub fn exit_code(&self) -> u8 {
        match self {
            AppError::NotImplemented { .. } => EXIT_NOT_IMPLEMENTED,
            _ => EXIT_FAILURE,
        }
    }

    /// Gợi ý cách sửa, nếu có.
    pub fn hint(&self) -> Option<String> {
        match self {
            AppError::NotImplemented { .. } => None,
            AppError::User { hint, .. } => hint.clone(),
            AppError::Api(e) => api_hint(e),
            AppError::Platform(PlatformError::Credential(_)) => Some(
                "Kiểm tra Windows Credential Manager (Control Panel → Credential Manager).".into(),
            ),
            AppError::Platform(_) => None,
            AppError::Config { .. } => {
                Some("Kiểm tra quyền ghi thư mục %LOCALAPPDATA%\\teamlens.".into())
            }
        }
    }
}

fn api_hint(e: &ApiError) -> Option<String> {
    match e {
        ApiError::Network { .. } => {
            Some("Kiểm tra địa chỉ server và kết nối mạng, rồi thử lại.".into())
        }
        ApiError::Api { code, .. } => match code {
            ApiErrorCode::InvalidToken | ApiErrorCode::Unauthenticated => Some(
                "Chạy lại `tl join <link mời>` (xin leader link còn hạn) để tham gia lại.".into(),
            ),
            ApiErrorCode::Forbidden => Some("Liên hệ leader để được cấp quyền.".into()),
            _ => None,
        },
        ApiError::InvalidResponse { .. } => Some(
            "Kiểm tra lại link mời (phải là link dashboard TeamLens dạng https://<server>/i/<mã>)."
                .into(),
        ),
        ApiError::Build(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_implemented_exits_with_code_2() {
        let e = AppError::NotImplemented {
            command: "sync",
            task: "M1.7",
        };
        assert_eq!(e.exit_code(), 2);
        assert_eq!(e.to_string(), "Chưa làm: lệnh sync thuộc task M1.7");
    }

    #[test]
    fn invalid_token_suggests_login() {
        let e = AppError::Api(ApiError::Api {
            status: 401,
            code: ApiErrorCode::InvalidToken,
            message: "Token không hợp lệ".into(),
        });
        assert_eq!(e.exit_code(), 1);
        assert!(e.hint().unwrap().contains("tl join"));
    }
}
