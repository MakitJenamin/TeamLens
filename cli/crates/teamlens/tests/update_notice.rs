//! Test dòng nhắc có bản `tl` mới ([`teamlens::update::notice`]) với GitHub API giả (wiremock):
//! kiểm nhẹ ghi `state.db`, server chậm thì không chặn lệnh quá giới hạn, lỗi mạng không đổi kết
//! quả lệnh. "stderr là terminal" được inject qua `NoticeOptions`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use clap::Parser;
use serde_json::json;
use teamlens::cli::{Cli, Command};
use teamlens::commands::dispatch;
use teamlens::context::AppContext;
use teamlens::state::{state_path, StateDb};
use teamlens::update::auto::{self, read_info};
use teamlens::update::notice::{NoticeOptions, Notifier};
use teamlens::update::{UpdateSource, Version, ASSET_NAME, SUMS_NAME};
use tempfile::TempDir;
use tl_platform::MemoryCredentialStore;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const API_PATH: &str = "/repos/MakitJenamin/TeamLens/releases/latest";

fn cmd(args: &[&str]) -> Command {
    let mut full = vec!["tl"];
    full.extend_from_slice(args);
    Cli::try_parse_from(full).unwrap().command
}

fn test_ctx(dir: &TempDir) -> AppContext {
    AppContext {
        config_path: dir.path().join("teamlens").join("config.toml"),
        credentials: Box::new(MemoryCredentialStore::new()),
        poll_unit: Duration::from_millis(1),
        open_browser: |_| panic!("test không được mở trình duyệt"),
    }
}

fn opts(server: &MockServer) -> NoticeOptions {
    NoticeOptions {
        stderr_is_terminal: true,
        disabled: false,
        source: UpdateSource {
            api_url: format!("{}{API_PATH}", server.uri()),
            base_url: None,
            version: None,
        },
        current: Version::parse("0.2.0").unwrap(),
        wait_after_command: Duration::from_secs(2),
        http_timeout: Duration::from_secs(3),
    }
}

fn release_json(server: &MockServer, tag: &str) -> serde_json::Value {
    json!({
        "tag_name": tag,
        "assets": [
            { "name": ASSET_NAME, "browser_download_url": format!("{}/{ASSET_NAME}", server.uri()) },
            { "name": SUMS_NAME, "browser_download_url": format!("{}/{SUMS_NAME}", server.uri()) },
        ]
    })
}

/// Chạy `start` → (lệnh) → `finish` trên thread thường (như `main`), trả dòng đã in.
fn run_notice(command: &[&str], db: &Path, opts: NoticeOptions) -> (bool, String, Duration) {
    let command = cmd(command);
    let db = db.to_path_buf();
    std::thread::spawn(move || {
        let started = Instant::now();
        let n = Notifier::start(&command, || Some(db), opts);
        let mut err = Vec::new();
        let printed = n.finish(&mut err);
        (printed, String::from_utf8(err).unwrap(), started.elapsed())
    })
    .join()
    .unwrap()
}

fn db_path(dir: &TempDir) -> PathBuf {
    dir.path().join("teamlens").join("state.db")
}

#[tokio::test(flavor = "multi_thread")]
async fn kiem_nhe_thanh_cong_ghi_state_va_lan_hai_khong_goi_mang() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(API_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(release_json(&server, "v0.2.1")))
        .expect(1)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let db = db_path(&dir);

    let o = opts(&server);
    let (printed, err, _) = tokio::task::spawn_blocking({
        let db = db.clone();
        move || run_notice(&["pause"], &db, o)
    })
    .await
    .unwrap();
    assert!(printed);
    assert_eq!(
        err,
        "\nCó bản tl 0.2.1 (đang dùng 0.2.0). Chạy `tl update`.\n"
    );
    let info = read_info(&StateDb::open(&db).unwrap());
    assert_eq!(info.latest_version.as_deref(), Some("0.2.1"));
    assert!(info.checked_at.is_some());
    assert_eq!(info.last_error, None);

    // Lần hai: đọc kết quả đã lưu, không gọi mạng (mock chỉ cho phép 1 lần).
    let o = opts(&server);
    let (printed, _, elapsed) = tokio::task::spawn_blocking(move || run_notice(&["sync"], &db, o))
        .await
        .unwrap();
    assert!(printed);
    assert!(
        elapsed < Duration::from_millis(500),
        "lần hai mất {elapsed:?}"
    );
    server.verify().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn server_cham_thi_bo_qua_khong_chan_qua_gioi_han() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(API_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(release_json(&server, "v0.2.1"))
                .set_delay(Duration::from_secs(10)),
        )
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let db = db_path(&dir);

    let o = opts(&server);
    let (printed, err, elapsed) = tokio::task::spawn_blocking({
        let db = db.clone();
        move || run_notice(&["pause"], &db, o)
    })
    .await
    .unwrap();
    assert!(!printed);
    assert!(err.is_empty());
    assert!(
        elapsed < Duration::from_millis(2500),
        "chờ quá giới hạn: {elapsed:?}"
    );
    // Mốc thử đã ghi trước khi gọi mạng; chưa có lần kiểm thành công, không ghi lỗi.
    let state = StateDb::open(&db).unwrap();
    assert!(state.meta(auto::META_LAST_ATTEMPT).unwrap().is_some());
    let info = read_info(&state);
    assert_eq!(info.checked_at, None);
    assert_eq!(info.last_error, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn loi_mang_khong_doi_ket_qua_lenh_va_khong_thu_lai_trong_1_gio() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(API_PATH))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_ctx(&dir);
    let db = state_path(&ctx.config_path);

    // Kết quả lệnh khi không có dòng nhắc.
    let mut out_plain = Vec::new();
    let plain = dispatch(cmd(&["pause"]), || Ok(test_ctx(&dir)), &mut out_plain).await;
    let plain_resume = dispatch(cmd(&["resume"]), || Ok(test_ctx(&dir)), &mut Vec::new()).await;
    assert_eq!(plain.is_ok(), plain_resume.is_ok());

    // Cùng lệnh, có dòng nhắc chạy song song với server lỗi.
    let command = cmd(&["pause"]);
    let n = Notifier::start(&command, || Some(db.clone()), opts(&server));
    let mut out = Vec::new();
    let with_notice = dispatch(command, || Ok(test_ctx(&dir)), &mut out).await;
    let mut err = Vec::new();
    let printed = tokio::task::spawn_blocking(move || {
        let p = n.finish(&mut err);
        (p, err)
    })
    .await
    .unwrap();
    assert!(!printed.0);
    assert!(printed.1.is_empty());
    assert_eq!(with_notice.is_ok(), plain.is_ok());
    assert_eq!(
        with_notice.as_ref().err().map(|e| e.exit_code()),
        plain.as_ref().err().map(|e| e.exit_code())
    );
    assert_eq!(out, out_plain, "stdout của lệnh không đổi");

    // Ngay sau lần lỗi: không thử lại (mock chỉ cho phép 1 request), không in.
    let o = opts(&server);
    let (printed, _, _) = tokio::task::spawn_blocking(move || run_notice(&["resume"], &db, o))
        .await
        .unwrap();
    assert!(!printed);
    server.verify().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn lenh_loai_tru_va_override_tl_update_version() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(release_json(&server, "v9.9.9")))
        .expect(0)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let db = db_path(&dir);

    for args in [
        &["update"][..],
        &["status", "--json"],
        &["daemon"],
        &["uninstall"],
    ] {
        let o = opts(&server);
        let db2 = db.clone();
        let (printed, _, _) = tokio::task::spawn_blocking(move || run_notice(args, &db2, o))
            .await
            .unwrap();
        assert!(!printed, "{args:?}");
    }
    assert!(!db.exists(), "lệnh loại trừ không mở/tạo state.db");

    // TL_UPDATE_VERSION: không gọi GitHub API, dùng phiên bản override.
    let mut o = opts(&server);
    o.source.version = Some("0.3.0".into());
    let (printed, err, _) = tokio::task::spawn_blocking(move || run_notice(&["pause"], &db, o))
        .await
        .unwrap();
    assert!(printed);
    assert!(err.contains("Có bản tl 0.3.0 (đang dùng 0.2.0)"));
    server.verify().await;
}

/// Thư mục dữ liệu mới: lệnh và thread nhắc cùng tạo/migrate `state.db` một lúc. Thread nhắc
/// không được thua cuộc đua mà bỏ qua im lặng.
#[tokio::test(flavor = "multi_thread")]
async fn state_db_moi_tao_cung_luc_voi_lenh() {
    let server = MockServer::start().await;
    for _ in 0..20 {
        let dir = tempfile::tempdir().unwrap();
        let ctx = test_ctx(&dir);
        let db = state_path(&ctx.config_path);
        let mut o = opts(&server);
        o.source.version = Some("0.3.0".into());
        let command = cmd(&["pause"]);
        let n = Notifier::start(&command, || Some(db.clone()), o);
        dispatch(command, || Ok(test_ctx(&dir)), &mut Vec::new())
            .await
            .unwrap();
        let printed = tokio::task::spawn_blocking(move || n.finish(&mut Vec::new()))
            .await
            .unwrap();
        assert!(printed, "thread nhắc thua cuộc đua mở state.db");
    }
}

/// State cũ hơn 24 giờ đã lưu 0.2.1, tạo bằng `record_check` lùi thời gian.
fn stale_state(db: &Path, latest: &str) {
    let state = StateDb::open(db).unwrap();
    let old = chrono::Utc::now() - chrono::Duration::hours(30);
    auto::record_check(&state, old, &Version::parse(latest).unwrap()).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn state_cu_va_api_hong_van_nhac_ban_da_luu() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(API_PATH))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let db = db_path(&dir);
    stale_state(&db, "0.2.1");

    let o = opts(&server);
    let (printed, err, elapsed) = tokio::task::spawn_blocking({
        let db = db.clone();
        move || run_notice(&["pause"], &db, o)
    })
    .await
    .unwrap();
    assert!(printed);
    assert_eq!(
        err,
        "
Có bản tl 0.2.1 (đang dùng 0.2.0). Chạy `tl update`.
"
    );
    assert!(elapsed < Duration::from_millis(2500), "{elapsed:?}");
    // Đã thử (mốc ghi), không ghi lỗi, bản lưu giữ nguyên.
    let info = read_info(&StateDb::open(&db).unwrap());
    assert_eq!(info.latest_version.as_deref(), Some("0.2.1"));
    assert_eq!(info.last_error, None);
    server.verify().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn state_cu_va_server_treo_van_nhac_trong_2_giay() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(API_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(release_json(&server, "v0.2.2"))
                .set_delay(Duration::from_secs(10)),
        )
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let db = db_path(&dir);
    stale_state(&db, "0.2.1");

    let o = opts(&server);
    let (printed, err, elapsed) =
        tokio::task::spawn_blocking(move || run_notice(&["pause"], &db, o))
            .await
            .unwrap();
    assert!(printed);
    assert!(err.contains("Có bản tl 0.2.1 (đang dùng 0.2.0)"), "{err}");
    assert!(
        elapsed >= Duration::from_millis(1900) && elapsed < Duration::from_millis(2500),
        "{elapsed:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn state_cu_kiem_thanh_cong_thi_dung_ket_qua_moi() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(API_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(release_json(&server, "v0.2.2")))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let db = db_path(&dir);
    stale_state(&db, "0.2.1");

    let o = opts(&server);
    let (printed, err, _) = tokio::task::spawn_blocking(move || run_notice(&["pause"], &db, o))
        .await
        .unwrap();
    assert!(printed);
    assert!(err.contains("Có bản tl 0.2.2 (đang dùng 0.2.0)"), "{err}");
}
