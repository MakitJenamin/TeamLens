//! HTTP client cho `/agent/v1`: reqwest + rustls, user-agent `teamlens-cli/<version>`,
//! tự gắn bearer token, parse lỗi `{ error, message }` thành [`ApiError`].

mod models;

use std::time::Duration;

use reqwest::{Method, RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;

pub use models::*;

/// Timeout cho mỗi request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Mã lỗi máy đọc được trong trường `error` của API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiErrorCode {
    AuthorizationPending,
    SlowDown,
    ExpiredToken,
    AccessDenied,
    InvalidToken,
    Unauthenticated,
    Forbidden,
    NotFound,
    /// Mã khác chưa có biến thể riêng.
    Other(String),
}

impl ApiErrorCode {
    pub fn parse(code: &str) -> Self {
        match code {
            "authorization_pending" => Self::AuthorizationPending,
            "slow_down" => Self::SlowDown,
            "expired_token" => Self::ExpiredToken,
            "access_denied" => Self::AccessDenied,
            "invalid_token" => Self::InvalidToken,
            "unauthenticated" => Self::Unauthenticated,
            "forbidden" => Self::Forbidden,
            "not_found" => Self::NotFound,
            other => Self::Other(other.to_owned()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::AuthorizationPending => "authorization_pending",
            Self::SlowDown => "slow_down",
            Self::ExpiredToken => "expired_token",
            Self::AccessDenied => "access_denied",
            Self::InvalidToken => "invalid_token",
            Self::Unauthenticated => "unauthenticated",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::Other(s) => s,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("Không kết nối được tới server {url}")]
    Network {
        url: String,
        #[source]
        source: reqwest::Error,
    },

    /// Server trả lỗi đúng định dạng `{ error, message }`.
    #[error("Server báo lỗi: {}", display_message(message, code))]
    Api {
        status: u16,
        code: ApiErrorCode,
        message: String,
    },

    /// Server trả nội dung không đúng contract (sai địa chỉ, proxy, phiên bản lệch...).
    #[error("Server trả phản hồi không hợp lệ (HTTP {status}): {detail}")]
    InvalidResponse { status: u16, detail: String },

    #[error("Không khởi tạo được HTTP client: {0}")]
    Build(#[source] reqwest::Error),
}

fn display_message(message: &str, code: &ApiErrorCode) -> String {
    if message.is_empty() {
        code.as_str().to_owned()
    } else {
        format!("{message} ({})", code.as_str())
    }
}

impl ApiError {
    /// Mã lỗi API nếu là lỗi đúng định dạng.
    pub fn code(&self) -> Option<&ApiErrorCode> {
        match self {
            ApiError::Api { code, .. } => Some(code),
            _ => None,
        }
    }
}

/// Client cho một server TeamLens.
#[derive(Debug, Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    base_url: String,
    token: Option<String>,
}

impl ApiClient {
    /// `base_url` là địa chỉ server đã chuẩn hóa (không có `/` ở cuối).
    pub fn new(base_url: &str, token: Option<String>) -> Result<Self, ApiError> {
        let http = reqwest::Client::builder()
            .user_agent(crate::user_agent())
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(ApiError::Build)?;
        Ok(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_owned(),
            token,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// `POST /agent/v1/device/code`.
    pub async fn device_code(
        &self,
        body: &DeviceCodeRequest,
    ) -> Result<DeviceCodeResponse, ApiError> {
        let req = self
            .request(Method::POST, "/agent/v1/device/code")
            .json(body);
        self.send_json(req).await
    }

    /// `POST /agent/v1/device/token`. Đang chờ duyệt thì trả
    /// `ApiError::Api { code: AuthorizationPending, .. }`.
    pub async fn device_token(&self, device_code: &str) -> Result<DeviceTokenResponse, ApiError> {
        let body = DeviceTokenRequest {
            device_code: device_code.to_owned(),
        };
        let req = self
            .request(Method::POST, "/agent/v1/device/token")
            .json(&body);
        self.send_json(req).await
    }

    /// `GET /agent/v1/whoami`.
    pub async fn whoami(&self) -> Result<WhoamiResponse, ApiError> {
        let req = self.request(Method::GET, "/agent/v1/whoami");
        self.send_json(req).await
    }

    /// `POST /agent/v1/logout`: thu hồi token của chính máy này.
    pub async fn logout(&self) -> Result<(), ApiError> {
        let req = self.request(Method::POST, "/agent/v1/logout");
        self.send_empty(req).await
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        let mut req = self.http.request(method, self.url(path));
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        req
    }

    async fn execute(&self, req: RequestBuilder) -> Result<Response, ApiError> {
        let resp = req.send().await.map_err(|source| ApiError::Network {
            url: self.base_url.clone(),
            source,
        })?;
        tracing::debug!(status = %resp.status(), url = %resp.url(), "phản hồi API");
        if resp.status().is_success() {
            Ok(resp)
        } else {
            Err(error_from_response(resp).await)
        }
    }

    async fn send_json<T: DeserializeOwned>(&self, req: RequestBuilder) -> Result<T, ApiError> {
        let resp = self.execute(req).await?;
        let status = resp.status().as_u16();
        let text = resp.text().await.map_err(|source| ApiError::Network {
            url: self.base_url.clone(),
            source,
        })?;
        serde_json::from_str(&text).map_err(|e| ApiError::InvalidResponse {
            status,
            detail: format!("JSON không đúng contract ({e})"),
        })
    }

    async fn send_empty(&self, req: RequestBuilder) -> Result<(), ApiError> {
        self.execute(req).await.map(|_| ())
    }
}

async fn error_from_response(resp: Response) -> ApiError {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    parse_error_body(status, &text)
}

/// Chuyển thân lỗi HTTP thành [`ApiError`]. Tách riêng để test.
pub fn parse_error_body(status: StatusCode, text: &str) -> ApiError {
    match serde_json::from_str::<ErrorBody>(text) {
        Ok(body) => ApiError::Api {
            status: status.as_u16(),
            code: ApiErrorCode::parse(&body.error),
            message: body.message,
        },
        Err(_) => {
            let snippet: String = text.chars().take(200).collect();
            ApiError::InvalidResponse {
                status: status.as_u16(),
                detail: if snippet.trim().is_empty() {
                    status
                        .canonical_reason()
                        .unwrap_or("không có nội dung")
                        .to_owned()
                } else {
                    snippet
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_error_codes() {
        let e = parse_error_body(
            StatusCode::BAD_REQUEST,
            r#"{"error":"slow_down","message":"Poll chậm lại"}"#,
        );
        match e {
            ApiError::Api {
                status,
                code,
                message,
            } => {
                assert_eq!(status, 400);
                assert_eq!(code, ApiErrorCode::SlowDown);
                assert_eq!(message, "Poll chậm lại");
            }
            other => panic!("sai loại lỗi: {other:?}"),
        }
    }

    #[test]
    fn parses_unknown_error_code_as_other() {
        let e = parse_error_body(
            StatusCode::CONFLICT,
            r#"{"error":"email_taken","message":"Email đã tồn tại"}"#,
        );
        assert_eq!(e.code(), Some(&ApiErrorCode::Other("email_taken".into())));
        assert_eq!(
            e.to_string(),
            "Server báo lỗi: Email đã tồn tại (email_taken)"
        );
    }

    #[test]
    fn non_json_body_is_invalid_response() {
        let e = parse_error_body(StatusCode::BAD_GATEWAY, "<html>Bad gateway</html>");
        assert!(matches!(e, ApiError::InvalidResponse { status: 502, .. }));
        let e = parse_error_body(StatusCode::NOT_FOUND, "");
        match e {
            ApiError::InvalidResponse { detail, .. } => assert_eq!(detail, "Not Found"),
            other => panic!("sai loại lỗi: {other:?}"),
        }
    }

    #[test]
    fn error_code_roundtrip() {
        for code in [
            "authorization_pending",
            "slow_down",
            "expired_token",
            "access_denied",
            "invalid_token",
            "unauthenticated",
            "forbidden",
            "not_found",
            "xyz",
        ] {
            assert_eq!(ApiErrorCode::parse(code).as_str(), code);
        }
    }
}
