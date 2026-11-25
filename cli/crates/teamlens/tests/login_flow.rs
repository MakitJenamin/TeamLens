//! Test luồng device login, status, logout với mock server (wiremock).
//! Credential store dùng `MemoryCredentialStore`, không đụng Credential Manager thật.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use teamlens::commands::{login, logout, status};
use teamlens::config::Config;
use teamlens::context::AppContext;
use teamlens::error::AppError;
use tempfile::TempDir;
use tl_platform::MemoryCredentialStore;
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const TOKEN: &str = "tld_test_token_123";

fn test_ctx(dir: &TempDir) -> AppContext {
    AppContext {
        config_path: dir.path().join("teamlens").join("config.toml"),
        credentials: Box::new(MemoryCredentialStore::new()),
        poll_unit: Duration::from_millis(1),
        open_browser: |_| panic!("test không được mở trình duyệt"),
    }
}

fn device_code_body(expires_in: u64) -> serde_json::Value {
    json!({
        "deviceCode": "dc_abc",
        "userCode": "WDJB-MJHT",
        "verificationUri": "http://localhost:3000/device",
        "verificationUriComplete": "http://localhost:3000/device?code=WDJB-MJHT",
        "expiresIn": expires_in,
        "interval": 5
    })
}

fn whoami_body() -> serde_json::Value {
    json!({
        "user": { "id": "u1", "email": "member1@teamlens.local", "name": "Member One" },
        "device": { "id": "d1", "name": "MAY-TEST" },
        "projects": [
            { "id": "p1", "name": "TeamLens", "slug": "teamlens", "role": "member",
              "repoPatterns": ["github.com/makitjenamin/teamlens"] },
            { "id": "p2", "name": "Demo", "slug": "demo", "role": "leader",
              "repoPatterns": ["github.com/acme/*"] }
        ]
    })
}

/// Trả lần lượt các phản hồi trong danh sách; hết thì lặp lại phản hồi cuối.
struct Sequence {
    calls: Arc<AtomicUsize>,
    responses: Vec<ResponseTemplate>,
}

impl Respond for Sequence {
    fn respond(&self, _req: &Request) -> ResponseTemplate {
        let i = self.calls.fetch_add(1, Ordering::SeqCst);
        self.responses[i.min(self.responses.len() - 1)].clone()
    }
}

fn api_error(status: u16, code: &str) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_json(json!({ "error": code, "message": "mô tả" }))
}

async fn mount_device_code(server: &MockServer, expires_in: u64) {
    Mock::given(method("POST"))
        .and(path("/agent/v1/device/code"))
        .and(header("user-agent", teamlens::user_agent().as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(device_code_body(expires_in)))
        .expect(1)
        .mount(server)
        .await;
}

async fn mount_token_sequence(
    server: &MockServer,
    responses: Vec<ResponseTemplate>,
) -> Arc<AtomicUsize> {
    let calls = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST"))
        .and(path("/agent/v1/device/token"))
        .and(body_json(json!({ "deviceCode": "dc_abc" })))
        .respond_with(Sequence {
            calls: calls.clone(),
            responses,
        })
        .mount(server)
        .await;
    calls
}

async fn mount_whoami(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/agent/v1/whoami"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(whoami_body()))
        .mount(server)
        .await;
}

fn login_args(server: Option<&str>) -> login::LoginArgs {
    login::LoginArgs {
        server: server.map(str::to_owned),
        no_browser: true,
    }
}

#[tokio::test]
async fn login_pending_then_slow_down_then_success() {
    let server = MockServer::start().await;
    mount_device_code(&server, 900).await;
    let calls = mount_token_sequence(
        &server,
        vec![
            api_error(400, "authorization_pending"),
            api_error(400, "slow_down"),
            ResponseTemplate::new(200)
                .set_body_json(json!({ "accessToken": TOKEN, "deviceId": "d1" })),
        ],
    )
    .await;
    mount_whoami(&server).await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let mut out = Vec::new();
    // Có `/` ở cuối để kiểm tra chuẩn hóa địa chỉ.
    let server_arg = format!("{}/", server.uri());
    let outcome = login::run(&ctx, login_args(Some(&server_arg)), &mut out)
        .await
        .expect("đăng nhập phải thành công");

    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(outcome.polls, 3);
    assert_eq!(
        outcome.final_interval_secs, 10,
        "slow_down phải cộng 5 giây"
    );
    assert_eq!(outcome.device_id, "d1");
    assert_eq!(outcome.email.as_deref(), Some("member1@teamlens.local"));
    assert_eq!(outcome.server_url, server.uri());

    // Token vào credential store, config chỉ có server_url.
    assert_eq!(
        ctx.credentials.get_token(&server.uri()).unwrap().as_deref(),
        Some(TOKEN)
    );
    let cfg = Config::load(&ctx.config_path).unwrap();
    assert_eq!(cfg.server_url.as_deref(), Some(server.uri().as_str()));
    let raw = std::fs::read_to_string(&ctx.config_path).unwrap();
    assert!(!raw.contains(TOKEN), "token không được ghi ra file config");

    let printed = String::from_utf8(out).unwrap();
    assert!(
        printed.contains("W D J B - M J H T"),
        "phải in mã to: {printed}"
    );
    assert!(printed.contains("http://localhost:3000/device?code=WDJB-MJHT"));
    assert!(printed.contains(&format!(
        "Đã đăng nhập: member1@teamlens.local trên {}",
        server.uri()
    )));
}

#[tokio::test]
async fn login_expired_token_fails_with_hint() {
    let server = MockServer::start().await;
    mount_device_code(&server, 900).await;
    mount_token_sequence(
        &server,
        vec![
            api_error(400, "authorization_pending"),
            api_error(400, "expired_token"),
        ],
    )
    .await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let err = login::run(&ctx, login_args(Some(&server.uri())), &mut Vec::new())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("hết hạn"), "{err}");
    assert!(err.hint().unwrap().contains("tl login"));
    assert_eq!(ctx.credentials.get_token(&server.uri()).unwrap(), None);
    assert!(!ctx.config_path.exists(), "thất bại thì không ghi config");
}

#[tokio::test]
async fn login_access_denied() {
    let server = MockServer::start().await;
    mount_device_code(&server, 900).await;
    mount_token_sequence(&server, vec![api_error(400, "access_denied")]).await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let err = login::run(&ctx, login_args(Some(&server.uri())), &mut Vec::new())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("từ chối"), "{err}");
}

#[tokio::test]
async fn login_gives_up_when_code_expires_locally() {
    let server = MockServer::start().await;
    // expiresIn = 12 giây, interval 5 → poll lúc 5, 10 rồi hết hạn.
    mount_device_code(&server, 12).await;
    let calls = mount_token_sequence(&server, vec![api_error(400, "authorization_pending")]).await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let err = login::run(&ctx, login_args(Some(&server.uri())), &mut Vec::new())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("hết hạn"), "{err}");
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn login_without_server_explains_what_to_do() {
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let err = login::run(&ctx, login_args(None), &mut Vec::new())
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::User { .. }));
    assert!(err.hint().unwrap().contains("--server"));
}

#[tokio::test]
async fn login_uses_server_from_config() {
    let server = MockServer::start().await;
    mount_device_code(&server, 900).await;
    mount_token_sequence(
        &server,
        vec![ResponseTemplate::new(200)
            .set_body_json(json!({ "accessToken": TOKEN, "deviceId": "d1" }))],
    )
    .await;
    mount_whoami(&server).await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    ctx.save_config(&Config {
        server_url: Some(server.uri()),
    })
    .unwrap();
    let outcome = login::run(&ctx, login_args(None), &mut Vec::new())
        .await
        .unwrap();
    assert_eq!(outcome.server_url, server.uri());
}

#[tokio::test]
async fn status_shows_account_and_projects() {
    let server = MockServer::start().await;
    mount_whoami(&server).await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    ctx.save_config(&Config {
        server_url: Some(server.uri()),
    })
    .unwrap();
    ctx.credentials.set_token(&server.uri(), TOKEN).unwrap();

    let mut out = Vec::new();
    status::run(&ctx, status::StatusArgs { json: false }, &mut out)
        .await
        .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert!(
        text.contains("Member One <member1@teamlens.local>"),
        "{text}"
    );
    assert!(text.contains("MAY-TEST"));
    assert!(text.contains("TeamLens (teamlens) · member"));
    assert!(text.contains("github.com/acme/*"));
    assert!(text.contains("chưa có (task M3-Y3)"));

    let mut out = Vec::new();
    status::run(&ctx, status::StatusArgs { json: true }, &mut out)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["loggedIn"], true);
    assert_eq!(v["server"], server.uri());
    assert_eq!(v["account"]["user"]["email"], "member1@teamlens.local");
    assert_eq!(
        v["account"]["projects"][1]["repoPatterns"][0],
        "github.com/acme/*"
    );
    assert_eq!(v["daemon"], "chưa có (task M3-Y3)");
}

#[tokio::test]
async fn status_not_logged_in() {
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let report = status::collect(&ctx).await.unwrap();
    assert_eq!(report.server, None);
    assert!(!report.logged_in);
    assert!(report.account.is_none());
}

#[tokio::test]
async fn status_reports_revoked_token() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/whoami"))
        .respond_with(api_error(401, "invalid_token"))
        .mount(&server)
        .await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    ctx.save_config(&Config {
        server_url: Some(server.uri()),
    })
    .unwrap();
    ctx.credentials.set_token(&server.uri(), TOKEN).unwrap();

    let report = status::collect(&ctx).await.unwrap();
    assert!(!report.logged_in);
    assert!(report.account_error.unwrap().contains("tl login"));
}

#[tokio::test]
async fn logout_revokes_and_deletes_token() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/logout"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    ctx.save_config(&Config {
        server_url: Some(server.uri()),
    })
    .unwrap();
    ctx.credentials.set_token(&server.uri(), TOKEN).unwrap();

    let mut out = Vec::new();
    logout::run(&ctx, logout::LogoutArgs {}, &mut out)
        .await
        .unwrap();
    assert_eq!(ctx.credentials.get_token(&server.uri()).unwrap(), None);
    assert!(String::from_utf8(out).unwrap().contains("Đã đăng xuất"));
}

#[tokio::test]
async fn logout_still_deletes_token_when_server_unreachable() {
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    // Cổng 9 (discard) gần như chắc chắn không có server HTTP.
    let url = "http://127.0.0.1:9";
    ctx.save_config(&Config {
        server_url: Some(url.into()),
    })
    .unwrap();
    ctx.credentials.set_token(url, TOKEN).unwrap();

    let mut out = Vec::new();
    logout::run(&ctx, logout::LogoutArgs {}, &mut out)
        .await
        .unwrap();
    assert_eq!(ctx.credentials.get_token(url).unwrap(), None);
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("Cảnh báo"), "{text}");
    assert!(text.contains("Đã đăng xuất"));
}

#[tokio::test]
async fn api_errors_are_parsed_from_real_http() {
    use teamlens::api_client::{ApiClient, ApiError, ApiErrorCode};

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/whoami"))
        .respond_with(api_error(403, "forbidden"))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/logout"))
        .respond_with(ResponseTemplate::new(500).set_body_string("Internal Server Error"))
        .mount(&server)
        .await;

    let client = ApiClient::new(&server.uri(), Some(TOKEN.into())).unwrap();
    match client.whoami().await.unwrap_err() {
        ApiError::Api { status, code, .. } => {
            assert_eq!(status, 403);
            assert_eq!(code, ApiErrorCode::Forbidden);
        }
        other => panic!("sai loại lỗi: {other:?}"),
    }
    assert!(matches!(
        client.logout().await.unwrap_err(),
        ApiError::InvalidResponse { status: 500, .. }
    ));
}

#[tokio::test]
async fn relogin_revokes_previous_token() {
    let server = MockServer::start().await;
    mount_device_code(&server, 900).await;
    mount_token_sequence(
        &server,
        vec![ResponseTemplate::new(200)
            .set_body_json(json!({ "accessToken": TOKEN, "deviceId": "d2" }))],
    )
    .await;
    mount_whoami(&server).await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/logout"))
        .and(header("authorization", "Bearer tld_old_token"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .named("logout bằng token cũ")
        .mount(&server)
        .await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    ctx.credentials
        .set_token(&server.uri(), "tld_old_token")
        .unwrap();

    login::run(&ctx, login_args(Some(&server.uri())), &mut Vec::new())
        .await
        .unwrap();

    assert_eq!(
        ctx.credentials.get_token(&server.uri()).unwrap().as_deref(),
        Some(TOKEN)
    );
    server.verify().await;
}

#[tokio::test]
async fn relogin_continues_when_revoking_old_token_fails() {
    let server = MockServer::start().await;
    mount_device_code(&server, 900).await;
    mount_token_sequence(
        &server,
        vec![ResponseTemplate::new(200)
            .set_body_json(json!({ "accessToken": TOKEN, "deviceId": "d2" }))],
    )
    .await;
    mount_whoami(&server).await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/logout"))
        .respond_with(api_error(401, "invalid_token"))
        .mount(&server)
        .await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    ctx.credentials
        .set_token(&server.uri(), "tld_old_token")
        .unwrap();

    login::run(&ctx, login_args(Some(&server.uri())), &mut Vec::new())
        .await
        .expect("lỗi khi thu hồi token cũ không được chặn đăng nhập");
    assert_eq!(
        ctx.credentials.get_token(&server.uri()).unwrap().as_deref(),
        Some(TOKEN)
    );
}

#[tokio::test]
async fn login_retries_on_proxy_5xx_while_polling() {
    let server = MockServer::start().await;
    mount_device_code(&server, 900).await;
    let calls = mount_token_sequence(
        &server,
        vec![
            ResponseTemplate::new(502).set_body_string("Bad Gateway"),
            ResponseTemplate::new(200)
                .set_body_json(json!({ "accessToken": TOKEN, "deviceId": "d1" })),
        ],
    )
    .await;
    mount_whoami(&server).await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let outcome = login::run(&ctx, login_args(Some(&server.uri())), &mut Vec::new())
        .await
        .expect("502 từ proxy phải được thử lại");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(outcome.polls, 2);
}

#[tokio::test]
async fn login_gives_up_after_repeated_5xx() {
    let server = MockServer::start().await;
    mount_device_code(&server, 900).await;
    let calls = mount_token_sequence(
        &server,
        vec![ResponseTemplate::new(503).set_body_string("Service Unavailable")],
    )
    .await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let err = login::run(&ctx, login_args(Some(&server.uri())), &mut Vec::new())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("503"), "{err}");
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn status_text_has_no_trailing_whitespace() {
    let server = MockServer::start().await;
    mount_whoami(&server).await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    ctx.save_config(&Config {
        server_url: Some(server.uri()),
    })
    .unwrap();
    ctx.credentials.set_token(&server.uri(), TOKEN).unwrap();

    let mut out = Vec::new();
    status::run(&ctx, status::StatusArgs { json: false }, &mut out)
        .await
        .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert!(text.lines().any(|l| l == "Project:"), "{text}");
    for line in text.lines() {
        assert_eq!(line, line.trim_end(), "dòng có khoảng trắng thừa: {line:?}");
    }
}
