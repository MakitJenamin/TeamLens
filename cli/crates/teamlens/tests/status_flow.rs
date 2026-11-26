//! Test `tl status`, `tl logout` và lỗi API với mock server (wiremock). Luồng `tl join`,
//! `tl open` ở `join_flow.rs`.
//! Credential store dùng `MemoryCredentialStore`, không đụng Credential Manager thật.

use std::time::Duration;

use serde_json::json;
use teamlens::commands::{logout, status};
use teamlens::config::Config;
use teamlens::context::AppContext;
use tempfile::TempDir;
use tl_platform::MemoryCredentialStore;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TOKEN: &str = "tld_test_token_123";

fn test_ctx(dir: &TempDir) -> AppContext {
    AppContext {
        config_path: dir.path().join("teamlens").join("config.toml"),
        credentials: Box::new(MemoryCredentialStore::new()),
        poll_unit: Duration::from_millis(1),
        open_browser: |_| panic!("test không được mở trình duyệt"),
    }
}

fn whoami_body() -> serde_json::Value {
    json!({
        "user": { "id": "u1", "email": null, "name": "Member One" },
        "role": "member",
        "device": { "id": "d1", "name": "MAY-TEST" },
        "projects": [
            { "id": "p1", "name": "TeamLens", "slug": "teamlens",
              "repoPatterns": ["github.com/makitjenamin/teamlens"] },
            { "id": "p2", "name": "Demo", "slug": "demo",
              "repoPatterns": ["github.com/acme/*"] }
        ]
    })
}

fn api_error(status: u16, code: &str) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_json(json!({ "error": code, "message": "mô tả" }))
}

async fn mount_whoami(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/agent/v1/whoami"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(whoami_body()))
        .mount(server)
        .await;
}

#[tokio::test]
async fn status_shows_account_and_projects() {
    let server = MockServer::start().await;
    mount_whoami(&server).await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    ctx.save_config(&Config {
        server_url: Some(server.uri()),
        ..Default::default()
    })
    .unwrap();
    ctx.credentials.set_token(&server.uri(), TOKEN).unwrap();

    let mut out = Vec::new();
    status::run(&ctx, status::StatusArgs { json: false }, &mut out)
        .await
        .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("Member One · member"), "{text}");
    assert!(text.contains("MAY-TEST"));
    assert!(text.contains("TeamLens (teamlens)"));
    assert!(text.contains("github.com/acme/*"));
    assert!(text.contains("chưa có (task M3.3)"));

    let mut out = Vec::new();
    status::run(&ctx, status::StatusArgs { json: true }, &mut out)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["loggedIn"], true);
    assert_eq!(v["server"], server.uri());
    assert_eq!(v["account"]["user"]["email"], serde_json::Value::Null);
    assert_eq!(v["account"]["role"], "member");
    assert_eq!(
        v["account"]["projects"][1]["repoPatterns"][0],
        "github.com/acme/*"
    );
    assert_eq!(v["daemon"], "chưa có (task M3.3)");
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
        ..Default::default()
    })
    .unwrap();
    ctx.credentials.set_token(&server.uri(), TOKEN).unwrap();

    let report = status::collect(&ctx).await.unwrap();
    assert!(!report.logged_in);
    assert!(report.account_error.unwrap().contains("tl join"));
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
        ..Default::default()
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
        ..Default::default()
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
async fn status_text_has_no_trailing_whitespace() {
    let server = MockServer::start().await;
    mount_whoami(&server).await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    ctx.save_config(&Config {
        server_url: Some(server.uri()),
        ..Default::default()
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
