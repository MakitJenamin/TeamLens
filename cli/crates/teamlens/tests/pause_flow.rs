//! Test `tl pause`, `tl resume` và `tl status` đầy đủ (M3.3) với mock server (wiremock).
//! Nguồn log rỗng (không đọc log thật của máy), `MemoryCredentialStore`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use teamlens::commands::{pause, status};
use teamlens::config::Config;
use teamlens::context::AppContext;
use teamlens::state::{state_path, StateDb};
use teamlens::sync::Sources;
use tempfile::TempDir;
use tl_platform::MemoryCredentialStore;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

const TOKEN: &str = "tld_test_token_m33";

fn ctx_for(dir: &TempDir, server: Option<&str>) -> AppContext {
    let ctx = AppContext {
        config_path: dir.path().join("teamlens").join("config.toml"),
        credentials: Box::new(MemoryCredentialStore::new()),
        poll_unit: Duration::from_millis(1),
        open_browser: |_| panic!("test không được mở trình duyệt"),
    };
    if let Some(url) = server {
        ctx.save_config(&Config {
            server_url: Some(url.to_owned()),
            ..Default::default()
        })
        .unwrap();
        ctx.credentials.set_token(url, TOKEN).unwrap();
    }
    ctx
}

fn no_sources() -> Sources {
    Sources {
        adapters: Vec::new(),
        prepare: Default::default(),
    }
}

/// Server trả `status` của body (hoặc `consent_revoked` khi `revoked`).
async fn heartbeat_server(revoked: bool) -> (MockServer, Arc<Mutex<Vec<Value>>>) {
    let server = MockServer::start().await;
    let bodies: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen = bodies.clone();
    Mock::given(method("POST"))
        .and(path("/agent/v1/heartbeat"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(move |req: &Request| {
            let body: Value = serde_json::from_slice(&req.body).unwrap();
            let status = if revoked {
                "consent_revoked".to_owned()
            } else {
                body["status"].as_str().unwrap().to_owned()
            };
            seen.lock().unwrap().push(body);
            ResponseTemplate::new(200).set_body_json(json!({
                "status": status, "consent_text_version": "v1", "min_cli_version": "0.1.0"
            }))
        })
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/whoami"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user": { "id": "u1", "email": null, "name": "Member One" },
            "role": "member",
            "device": { "id": "d1", "name": "MAY-TEST" },
            "projects": []
        })))
        .mount(&server)
        .await;
    (server, bodies)
}

async fn set(ctx: &AppContext, paused: bool) -> String {
    let mut out = Vec::new();
    pause::set_paused(ctx, paused, &no_sources(), &mut out)
        .await
        .unwrap();
    String::from_utf8(out).unwrap()
}

async fn status_text(ctx: &AppContext, json: bool) -> String {
    let mut out = Vec::new();
    status::run_with(ctx, status::StatusArgs { json }, &no_sources(), &mut out)
        .await
        .unwrap();
    String::from_utf8(out).unwrap()
}

fn db(ctx: &AppContext) -> StateDb {
    StateDb::open(&state_path(&ctx.config_path)).unwrap()
}

#[tokio::test]
async fn pause_resume_gui_heartbeat_ngay_va_doi_trang_thai() {
    let (server, bodies) = heartbeat_server(false).await;
    let dir = TempDir::new().unwrap();
    let ctx = ctx_for(&dir, Some(&server.uri()));

    let out = set(&ctx, true).await;
    assert!(out.contains("Đã tạm dừng thu thập"), "{out}");
    assert!(out.contains("không bao giờ được gửi"), "{out}");
    assert!(out.contains("trạng thái thiết bị là paused"), "{out}");
    assert!(db(&ctx).is_paused().unwrap());

    let text = status_text(&ctx, false).await;
    assert!(text.contains("Trạng thái: tạm dừng từ"), "{text}");
    assert!(text.contains("server ghi nhận: tạm dừng"), "{text}");
    assert!(text.contains("Daemon:     chưa chạy"), "{text}");
    assert!(text.contains("Hàng đợi:   trống"), "{text}");
    assert!(text.contains("Lỗi parse:  không có"), "{text}");
    assert!(text.contains("Agent:      chưa thấy log"), "{text}");

    let out = set(&ctx, true).await;
    assert!(out.contains("đã tạm dừng từ trước"), "{out}");

    let out = set(&ctx, false).await;
    assert!(out.contains("Đã tiếp tục thu thập"), "{out}");
    assert!(out.contains("trạng thái thiết bị là online"), "{out}");
    assert!(!db(&ctx).is_paused().unwrap());
    let windows = db(&ctx).pause_windows().unwrap();
    assert_eq!(windows.len(), 1, "pause hai lần chỉ mở một khoảng");
    assert!(windows[0].end.is_some());

    let statuses: Vec<String> = bodies
        .lock()
        .unwrap()
        .iter()
        .map(|b| b["status"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(statuses, ["paused", "paused", "online"]);
    let b = bodies.lock().unwrap()[0].clone();
    assert_eq!(b["cli_version"], teamlens::CLI_VERSION);
    assert_eq!(b["parse_errors"], 0);
    assert_eq!(
        b["queue"],
        json!({ "batches": 0, "bytes": 0, "dropped": 0, "failed": 0 })
    );

    let v: Value = serde_json::from_str(&status_text(&ctx, true).await).unwrap();
    assert_eq!(v["paused"], false);
    assert_eq!(v["lastHeartbeat"]["status"], "online");
    #[cfg(windows)]
    assert_eq!(v["daemon"]["running"], false);
}

#[tokio::test]
async fn pause_khi_mat_mang_van_tam_dung_o_may() {
    let dir = TempDir::new().unwrap();
    // Cổng 9 (discard) gần như chắc chắn không có server HTTP.
    let ctx = ctx_for(&dir, Some("http://127.0.0.1:9"));
    let out = set(&ctx, true).await;
    assert!(out.contains("Chưa báo được server"), "{out}");
    assert!(db(&ctx).is_paused().unwrap());
    let text = status_text(&ctx, false).await;
    assert!(text.contains("tạm dừng từ"), "{text}");
    assert!(text.contains("Heartbeat:  chưa gửi"), "{text}");
    assert!(text.contains("lần gửi gần nhất lỗi"), "{text}");
}

#[tokio::test]
async fn pause_chua_tham_gia_chi_doi_o_may() {
    let dir = TempDir::new().unwrap();
    let ctx = ctx_for(&dir, None);
    let out = set(&ctx, true).await;
    assert!(out.contains("chưa tham gia server nào"), "{out}");
    assert!(db(&ctx).is_paused().unwrap());
}

#[tokio::test]
async fn server_bao_da_rut_dong_y() {
    let (server, _) = heartbeat_server(true).await;
    let dir = TempDir::new().unwrap();
    let ctx = ctx_for(&dir, Some(&server.uri()));
    let out = set(&ctx, false).await;
    assert!(out.contains("đã rút đồng ý"), "{out}");
    let text = status_text(&ctx, false).await;
    assert!(text.contains("server ghi nhận: đã rút đồng ý"), "{text}");
}

#[tokio::test]
async fn status_hien_loi_parse() {
    let dir = TempDir::new().unwrap();
    let ctx = ctx_for(&dir, None);
    db(&ctx)
        .record_parse_errors(std::path::Path::new("a.jsonl"), "claude_code", 2, true)
        .unwrap();
    let text = status_text(&ctx, false).await;
    assert!(text.contains("Lỗi parse:  3"), "{text}");
    assert!(text.contains("Trạng thái: đang thu thập"), "{text}");
}
