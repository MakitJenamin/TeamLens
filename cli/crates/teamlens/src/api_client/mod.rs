//! HTTP client cho `/agent/v1`: reqwest + rustls, user-agent `teamlens-cli/<version>`,
//! tự gắn bearer token, parse lỗi `{ error, message }` thành [`ApiError`].

mod models;

use std::time::Duration;

use reqwest::{Method, RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;

pub use models::*;

/// Timeout cho mỗi request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Kết nối keep-alive rảnh quá lâu thì bỏ, không dùng lại. Phải ngắn hơn keep-alive của server
/// (Node/Next mặc định 5 giây): `tl sync` quét log hàng chục giây trên cùng luồng tokio nên
/// không phát hiện được server đã đóng kết nối, dùng lại sẽ lỗi "connection aborted" (os error 10053).
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(3);

/// Mã lỗi máy đọc được trong trường `error` của API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiErrorCode {
    InvalidToken,
    Unauthenticated,
    Forbidden,
    NotFound,
    InviteNotFound,
    InviteExpired,
    InviteUsedUp,
    InviteRevoked,
    ConsentOutdated,
    RateLimited,
    /// Mã khác chưa có biến thể riêng.
    Other(String),
}

impl ApiErrorCode {
    pub fn parse(code: &str) -> Self {
        match code {
            "invalid_token" => Self::InvalidToken,
            "unauthenticated" => Self::Unauthenticated,
            "forbidden" => Self::Forbidden,
            "not_found" => Self::NotFound,
            "invite_not_found" => Self::InviteNotFound,
            "invite_expired" => Self::InviteExpired,
            "invite_used_up" => Self::InviteUsedUp,
            "invite_revoked" => Self::InviteRevoked,
            "consent_outdated" => Self::ConsentOutdated,
            "rate_limited" => Self::RateLimited,
            other => Self::Other(other.to_owned()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::InvalidToken => "invalid_token",
            Self::Unauthenticated => "unauthenticated",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::InviteNotFound => "invite_not_found",
            Self::InviteExpired => "invite_expired",
            Self::InviteUsedUp => "invite_used_up",
            Self::InviteRevoked => "invite_revoked",
            Self::ConsentOutdated => "consent_outdated",
            Self::RateLimited => "rate_limited",
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

/// Lỗi riêng của `POST /agent/v1/ingest` cần CLI xử lý khác lỗi thường.
#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    /// `413`: batch quá lớn, cần chia nhỏ rồi gửi lại.
    #[error("Batch quá lớn so với giới hạn của server")]
    TooLarge,
    /// `429`: gửi quá nhanh; chờ `retry_after` giây (nếu server báo) rồi thử lại.
    #[error("Server báo gửi quá nhanh: {message}")]
    RateLimited {
        retry_after: Option<u64>,
        message: String,
    },
    /// `426`: server không hỗ trợ `schema_version` này, cần cập nhật CLI.
    #[error("Server không nhận phiên bản dữ liệu của tl này: {message}")]
    UpgradeRequired {
        min_cli_version: Option<String>,
        message: String,
    },
    #[error(transparent)]
    Api(#[from] ApiError),
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
            .pool_idle_timeout(POOL_IDLE_TIMEOUT)
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

    /// `GET /agent/v1/invites/{code}`: xem trước link mời (công khai).
    pub async fn preview_invite(&self, code: &str) -> Result<InvitePreview, ApiError> {
        let req = self.request(Method::GET, &format!("/agent/v1/invites/{code}"));
        self.send_json(req).await
    }

    /// `POST /agent/v1/join`: đổi mã mời + bản đồng ý lấy device token. Client có token
    /// (máy đã tham gia) thì server chỉ thêm vào project, không trả token mới.
    pub async fn join(&self, body: &JoinRequest) -> Result<JoinResult, ApiError> {
        let req = self.request(Method::POST, "/agent/v1/join").json(body);
        self.send_json(req).await
    }

    /// `POST /agent/v1/web-login`: link đăng nhập dashboard một lần cho `tl open`.
    pub async fn web_login(&self) -> Result<WebLoginResponse, ApiError> {
        let req = self.request(Method::POST, "/agent/v1/web-login");
        self.send_json(req).await
    }

    /// `GET /agent/v1/whoami`.
    pub async fn whoami(&self) -> Result<WhoamiResponse, ApiError> {
        let req = self.request(Method::GET, "/agent/v1/whoami");
        self.send_json(req).await
    }

    /// `GET /agent/v1/config`: cấu hình cho CLI (phạm vi repo, che secret, ngưỡng cắt, phiên bản).
    pub async fn get_config(&self) -> Result<AgentConfig, ApiError> {
        let req = self.request(Method::GET, "/agent/v1/config");
        self.send_json(req).await
    }

    /// `POST /agent/v1/heartbeat` (M3.3): báo trạng thái thiết bị (JSON snake_case).
    pub async fn heartbeat(&self, body: &HeartbeatRequest) -> Result<HeartbeatResult, ApiError> {
        let req = self.request(Method::POST, "/agent/v1/heartbeat").json(body);
        self.send_json(req).await
    }

    /// `GET /agent/v1/consent` (M3.7): văn bản đồng ý hiện hành và trạng thái đồng ý của thiết bị.
    pub async fn get_consent(&self) -> Result<ConsentStatus, ApiError> {
        let req = self.request(Method::GET, "/agent/v1/consent");
        self.send_json(req).await
    }

    /// `POST /agent/v1/consent` (M3.7): đồng ý lại hoặc rút đồng ý của thiết bị này.
    /// Sai phiên bản văn bản khi đồng ý lại thì `409 consent_outdated`.
    pub async fn update_consent(&self, body: &ConsentUpdate) -> Result<ConsentStatus, ApiError> {
        let req = self.request(Method::POST, "/agent/v1/consent").json(body);
        self.send_json(req).await
    }

    /// `POST /agent/v1/logout`: thu hồi token của chính máy này.
    pub async fn logout(&self) -> Result<(), ApiError> {
        let req = self.request(Method::POST, "/agent/v1/logout");
        self.send_empty(req).await
    }

    /// `POST /agent/v1/ingest` với body JSON đã nén gzip (`Content-Encoding: gzip`).
    pub async fn ingest_gzip(&self, gzip_body: Vec<u8>) -> Result<IngestResult, IngestError> {
        let req = self
            .request(Method::POST, "/agent/v1/ingest")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::CONTENT_ENCODING, "gzip")
            .body(gzip_body);
        let resp = req.send().await.map_err(|source| ApiError::Network {
            url: self.base_url.clone(),
            source,
        })?;
        let status = resp.status();
        tracing::debug!(status = %status, "phản hồi ingest");
        if status.is_success() {
            let text = resp.text().await.map_err(|source| ApiError::Network {
                url: self.base_url.clone(),
                source,
            })?;
            return serde_json::from_str(&text).map_err(|e| {
                ApiError::InvalidResponse {
                    status: status.as_u16(),
                    detail: format!("JSON không đúng contract ({e})"),
                }
                .into()
            });
        }
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        let text = resp.text().await.unwrap_or_default();
        Err(ingest_error(status, retry_after, &text))
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

/// Chuyển phản hồi lỗi của ingest thành [`IngestError`]. Tách riêng để test.
pub fn ingest_error(status: StatusCode, retry_after: Option<u64>, text: &str) -> IngestError {
    match status {
        StatusCode::PAYLOAD_TOO_LARGE => IngestError::TooLarge,
        StatusCode::TOO_MANY_REQUESTS => IngestError::RateLimited {
            retry_after,
            message: serde_json::from_str::<ErrorBody>(text)
                .map(|b| b.message)
                .unwrap_or_default(),
        },
        StatusCode::UPGRADE_REQUIRED => {
            let body: Option<UnsupportedSchemaVersionBody> = serde_json::from_str(text).ok();
            IngestError::UpgradeRequired {
                min_cli_version: body.as_ref().and_then(|b| b.min_cli_version.clone()),
                message: body.map(|b| b.message).unwrap_or_default(),
            }
        }
        _ => IngestError::Api(parse_error_body(status, text)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Server HTTP tối giản: trả 200 keep-alive rồi tự đóng kết nối sau 300 ms
    /// (như Node đóng kết nối rảnh sau keepAliveTimeout). Trả địa chỉ và bộ đếm kết nối.
    fn spawn_closing_server() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{Read, Write};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let count = std::sync::Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                counter.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 1024];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match stream.read(&mut chunk) {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok",
                    );
                    std::thread::sleep(Duration::from_millis(300));
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                });
            }
        });
        (format!("http://{addr}"), count)
    }

    /// Hồi quy: `tl sync` quét log lâu (chặn luồng tokio) rồi mới gửi; không được dùng lại
    /// kết nối keep-alive mà server đã đóng trong lúc đó.
    #[tokio::test]
    async fn does_not_reuse_idle_connection_closed_by_server() {
        let (url, connections) = spawn_closing_server();
        let client = ApiClient::new(&url, None).unwrap();
        let first = client.http.get(format!("{url}/a")).send().await.unwrap();
        assert_eq!(first.text().await.unwrap(), "ok");
        // Chặn luồng runtime như lúc quét log: pool không kịp thấy server đóng kết nối.
        std::thread::sleep(POOL_IDLE_TIMEOUT + Duration::from_millis(500));
        let second = client.http.get(format!("{url}/b")).send().await;
        assert!(
            second.is_ok(),
            "request sau khi rảnh lâu bị lỗi: {second:?}"
        );
        assert_eq!(connections.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn parses_known_error_codes() {
        let e = parse_error_body(
            StatusCode::GONE,
            r#"{"error":"invite_expired","message":"Link mời đã hết hạn"}"#,
        );
        match e {
            ApiError::Api {
                status,
                code,
                message,
            } => {
                assert_eq!(status, 410);
                assert_eq!(code, ApiErrorCode::InviteExpired);
                assert_eq!(message, "Link mời đã hết hạn");
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
    fn ingest_error_theo_ma_http() {
        assert!(matches!(
            ingest_error(StatusCode::PAYLOAD_TOO_LARGE, None, "<html>"),
            IngestError::TooLarge
        ));
        match ingest_error(
            StatusCode::UPGRADE_REQUIRED,
            None,
            r#"{"error":"unsupported_schema_version","message":"Cập nhật","supportedSchemaVersions":[1],"minCliVersion":"0.2.0"}"#,
        ) {
            IngestError::UpgradeRequired {
                min_cli_version, ..
            } => {
                assert_eq!(min_cli_version.as_deref(), Some("0.2.0"));
            }
            other => panic!("sai loại lỗi: {other:?}"),
        }
        match ingest_error(StatusCode::TOO_MANY_REQUESTS, Some(7), "") {
            IngestError::RateLimited { retry_after, .. } => assert_eq!(retry_after, Some(7)),
            other => panic!("sai loại lỗi: {other:?}"),
        }
        assert!(matches!(
            ingest_error(
                StatusCode::UNAUTHORIZED,
                None,
                r#"{"error":"invalid_token","message":"x"}"#
            ),
            IngestError::Api(ApiError::Api { status: 401, .. })
        ));
    }

    #[test]
    fn error_code_roundtrip() {
        for code in [
            "invalid_token",
            "unauthenticated",
            "forbidden",
            "not_found",
            "invite_not_found",
            "invite_expired",
            "invite_used_up",
            "invite_revoked",
            "consent_outdated",
            "rate_limited",
            "xyz",
        ] {
            assert_eq!(ApiErrorCode::parse(code).as_str(), code);
        }
    }
}
