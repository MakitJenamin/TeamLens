//! Test `tl uninstall` với mock server (wiremock) và Platform giả (không đụng Task Scheduler thật).

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde_json::json;
use teamlens::commands::uninstall::{self, UninstallArgs};
use teamlens::config::Config;
use teamlens::consent::{self as local_consent, ProjectConsent};
use teamlens::context::AppContext;
use teamlens::state::{state_path, StateDb};
use tempfile::TempDir;
use tl_platform::{CredentialStore, InstanceGuard, MemoryCredentialStore, Platform, PlatformError};
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TOKEN: &str = "tld_uninstall_token";

/// Platform giả: đếm số lần gỡ task, có thể cấu hình để báo lỗi.
#[derive(Clone, Default)]
struct FakePlatform {
    unregister_calls: Arc<AtomicUsize>,
    fail_unregister: bool,
}

impl Platform for FakePlatform {
    fn data_dir(&self) -> Result<PathBuf, PlatformError> {
        unreachable!("uninstall không dùng thư mục dữ liệu của platform")
    }
    fn credential_store(&self) -> Box<dyn CredentialStore> {
        unreachable!("uninstall dùng credential store của context")
    }
    fn acquire_single_instance(&self, _name: &str) -> Result<Option<InstanceGuard>, PlatformError> {
        unreachable!("uninstall không giữ mutex")
    }
    fn register_autostart(&self, _exe: &Path) -> Result<(), PlatformError> {
        unreachable!("uninstall không đăng ký task")
    }
    fn unregister_autostart(&self) -> Result<(), PlatformError> {
        self.unregister_calls.fetch_add(1, Ordering::SeqCst);
        if self.fail_unregister {
            Err(PlatformError::Os("bị chặn".into()))
        } else {
            Ok(())
        }
    }
    fn autostart_registered(&self) -> Result<bool, PlatformError> {
        unreachable!("uninstall không hỏi trạng thái task")
    }
    fn start_autostart(&self) -> Result<(), PlatformError> {
        unreachable!("uninstall không chạy task")
    }
}

fn test_ctx(dir: &TempDir) -> AppContext {
    AppContext {
        config_path: dir.path().join("teamlens").join("config.toml"),
        credentials: Box::new(MemoryCredentialStore::new()),
        poll_unit: Duration::from_millis(1),
        open_browser: |_| panic!("test không được mở trình duyệt"),
    }
}

fn data_dir(ctx: &AppContext) -> PathBuf {
    ctx.config_path.parent().unwrap().to_path_buf()
}

/// Máy đã tham gia `server`, có token và các file dữ liệu TeamLens (kèm một file lạ của người dùng).
fn joined(ctx: &AppContext, server: &MockServer) {
    let url = server.uri();
    let mut config = Config {
        server_url: Some(url.clone()),
        ..Default::default()
    };
    local_consent::record(
        &mut config,
        &url,
        ProjectConsent {
            project_id: "p1".into(),
            project_slug: "teamlens".into(),
            project_name: "TeamLens".into(),
            text_version: "v2".into(),
            backfill: false,
            accepted_at: Utc::now(),
        },
    );
    ctx.save_config(&config).unwrap();
    ctx.credentials.set_token(&url, TOKEN).unwrap();
    // state.db thật (kèm file phụ của SQLite) và log, cache cấu hình.
    drop(StateDb::open(&state_path(&ctx.config_path)).unwrap());
    let dir = data_dir(ctx);
    std::fs::write(dir.join("daemon.log"), "log").unwrap();
    std::fs::write(dir.join("daemon.log.1"), "log cũ").unwrap();
    std::fs::write(dir.join("agent_config.json"), "{}").unwrap();
}

fn status_revoked() -> serde_json::Value {
    json!({
        "textVersion": "v2",
        "text": "Văn bản",
        "status": "revoked",
        "acceptedVersion": null,
        "backfill": null,
        "grantedAt": null,
        "revokedAt": "2026-11-27T09:00:00.000Z"
    })
}

fn yes() -> UninstallArgs {
    UninstallArgs { yes: true }
}

fn text(out: Vec<u8>) -> String {
    String::from_utf8(out).unwrap()
}

#[tokio::test]
async fn go_cai_dat_bao_server_go_task_xoa_token_va_file() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .and(body_json(json!({ "action": "revoke" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(status_revoked()))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/logout"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server);
    let platform = FakePlatform::default();

    let mut out = Vec::new();
    let report = uninstall::run_with(&ctx, &yes(), &platform, &mut Cursor::new(""), &mut out)
        .await
        .unwrap();

    assert!(report.server_notified);
    assert!(report.device_revoked);
    assert!(report.task_removed);
    assert!(report.token_deleted);
    assert_eq!(platform.unregister_calls.load(Ordering::SeqCst), 1);
    assert!(report.failed_files.is_empty(), "{:?}", report.failed_files);
    for name in [
        "config.toml",
        "state.db",
        "daemon.log",
        "daemon.log.1",
        "agent_config.json",
    ] {
        assert!(
            report.removed_files.iter().any(|f| f == name),
            "thiếu {name}: {report:?}"
        );
    }
    assert!(ctx.credentials.get_token(&server.uri()).unwrap().is_none());
    assert!(!ctx.config_path.exists());
    assert!(!state_path(&ctx.config_path).exists());
    assert!(
        !data_dir(&ctx).exists(),
        "thư mục dữ liệu rỗng thì được xóa"
    );
    let printed = text(out);
    assert!(printed.contains("Đã gỡ TeamLens"), "{printed}");
    assert!(
        printed.contains("báo server rút đồng ý: đã làm"),
        "{printed}"
    );
}

#[tokio::test]
async fn khong_xoa_file_la_cua_nguoi_dung_va_giu_thu_muc() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(status_revoked()))
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server);
    let keep = data_dir(&ctx).join("ghi-chu-cua-toi.txt");
    std::fs::write(&keep, "đừng xóa").unwrap();

    uninstall::run_with(
        &ctx,
        &yes(),
        &FakePlatform::default(),
        &mut Cursor::new(""),
        &mut Vec::new(),
    )
    .await
    .unwrap();
    assert!(keep.exists(), "file lạ trong thư mục dữ liệu phải còn");
    assert!(!ctx.config_path.exists());
}

#[tokio::test]
async fn mat_mang_hoac_go_task_loi_van_don_sach_tren_may_va_canh_bao() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500).set_body_string("lỗi máy chủ"))
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server);
    let platform = FakePlatform {
        fail_unregister: true,
        ..Default::default()
    };

    let mut out = Vec::new();
    let report = uninstall::run_with(&ctx, &yes(), &platform, &mut Cursor::new(""), &mut out)
        .await
        .unwrap();
    assert!(!report.server_notified);
    assert!(!report.device_revoked);
    assert!(!report.task_removed);
    assert!(report.token_deleted, "token vẫn phải xóa khỏi máy");
    assert!(!ctx.config_path.exists(), "file vẫn phải xóa");
    let printed = text(out);
    assert!(
        printed.contains("chưa báo được server rút đồng ý"),
        "{printed}"
    );
    assert!(printed.contains("chưa thu hồi được thiết bị"), "{printed}");
    assert!(printed.contains("chưa gỡ được tác vụ tự chạy"), "{printed}");
}

#[tokio::test]
async fn huy_xac_nhan_thi_khong_doi_gi() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server);
    let platform = FakePlatform::default();

    let err = uninstall::run_with(
        &ctx,
        &UninstallArgs { yes: false },
        &platform,
        &mut Cursor::new("khong\n"),
        &mut Vec::new(),
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("Đã hủy"), "{err}");
    assert_eq!(platform.unregister_calls.load(Ordering::SeqCst), 0);
    assert!(ctx.config_path.exists());
    assert!(ctx.credentials.get_token(&server.uri()).unwrap().is_some());
}

#[tokio::test]
async fn go_hai_lan_va_may_chua_tham_gia_deu_khong_loi() {
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let platform = FakePlatform::default();
    // Máy chưa tham gia, chưa có file nào.
    let report = uninstall::run_with(
        &ctx,
        &yes(),
        &platform,
        &mut Cursor::new(""),
        &mut Vec::new(),
    )
    .await
    .unwrap();
    assert!(report.removed_files.is_empty());
    assert!(!report.server_notified);

    // Đã gỡ rồi chạy lại.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(status_revoked()))
        .mount(&server)
        .await;
    joined(&ctx, &server);
    uninstall::run_with(
        &ctx,
        &yes(),
        &platform,
        &mut Cursor::new(""),
        &mut Vec::new(),
    )
    .await
    .unwrap();
    let again = uninstall::run_with(
        &ctx,
        &yes(),
        &platform,
        &mut Cursor::new(""),
        &mut Vec::new(),
    )
    .await
    .unwrap();
    assert!(again.removed_files.is_empty(), "{again:?}");
}
