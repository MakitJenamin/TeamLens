//! Test `tl update` / tự cập nhật (M5.3) với server HTTP giả (wiremock): tìm bản phát hành qua
//! GitHub API, tải `SHA256SUMS` + zip, kiểm SHA-256, giải nén `tl.exe`. Bước thay file thật
//! (`self_replace`) không chạy trong test (sẽ ghi đè binary test); đã thử tay, xem PR.

use std::path::Path;
use std::time::Duration;

use chrono::Utc;
use serde_json::json;
use teamlens::commands::status;
use teamlens::commands::update::{check_and_record, report_check};
use teamlens::context::AppContext;
use teamlens::state::{state_path, StateDb};
use teamlens::update::auto::{self, AutoOutcome, AutoSchedule};
use teamlens::update::sums::sha256_hex;
use teamlens::update::{UpdateError, UpdateSource, Updater, ASSET_NAME, SUMS_NAME};
use tempfile::TempDir;
use tl_platform::MemoryCredentialStore;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn test_ctx(dir: &TempDir) -> AppContext {
    AppContext {
        config_path: dir.path().join("teamlens").join("config.toml"),
        credentials: Box::new(MemoryCredentialStore::new()),
        poll_unit: Duration::from_millis(1),
        open_browser: |_| panic!("test không được mở trình duyệt"),
    }
}

/// Zip tối thiểu (phương thức stored) chứa các file ở gốc.
fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let mut crc = flate2::Crc::new();
        crc.update(data);
        let crc = crc.sum();
        let offset = out.len() as u32;
        let size = data.len() as u32;
        let name_len = name.len() as u16;
        // Local file header.
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u16.to_le_bytes()); // stored
        out.extend_from_slice(&0u16.to_le_bytes()); // time
        out.extend_from_slice(&0x21u16.to_le_bytes()); // date 1980-01-01
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&name_len.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);
        // Central directory entry.
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // made by
        central.extend_from_slice(&20u16.to_le_bytes()); // needed
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0x21u16.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&name_len.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attr
        central.extend_from_slice(&0u32.to_le_bytes()); // external attr
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let cd_offset = out.len() as u32;
    let cd_size = central.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

const FAKE_EXE: &[u8] = b"MZ day khong phai exe that, chi de kiem tai va giai nen";

/// Server giả: GitHub API `releases/latest` + thư mục asset `/dl/<tag>/`.
struct FakeRelease {
    server: MockServer,
}

impl FakeRelease {
    async fn start(tag: &str, zip: Vec<u8>, sums: String) -> Self {
        let server = MockServer::start().await;
        let base = format!("{}/dl/{tag}", server.uri());
        Mock::given(method("GET"))
            .and(path("/repos/MakitJenamin/TeamLens/releases/latest"))
            .and(header("accept", "application/vnd.github+json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "tag_name": tag,
                "prerelease": false,
                "assets": [
                    { "name": "tl-x86_64-pc-windows-msvc.zip.sig",
                      "browser_download_url": format!("{base}/khong-dung") },
                    { "name": ASSET_NAME, "browser_download_url": format!("{base}/{ASSET_NAME}") },
                    { "name": SUMS_NAME, "browser_download_url": format!("{base}/{SUMS_NAME}") }
                ]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/dl/{tag}/{ASSET_NAME}")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/dl/{tag}/{SUMS_NAME}")))
            .respond_with(ResponseTemplate::new(200).set_body_string(sums))
            .mount(&server)
            .await;
        Self { server }
    }

    /// Bản phát hành đúng: hash khớp.
    async fn good(tag: &str) -> Self {
        let zip = make_zip(&[("tl.exe", FAKE_EXE)]);
        let sums = format!(
            "{}  {ASSET_NAME}\n{}  khac.txt\n",
            sha256_hex(&zip),
            sha256_hex(b"khac")
        );
        Self::start(tag, zip, sums).await
    }

    fn updater(&self) -> Updater {
        Updater::new(UpdateSource {
            api_url: format!(
                "{}/repos/MakitJenamin/TeamLens/releases/latest",
                self.server.uri()
            ),
            base_url: None,
            version: None,
        })
        .unwrap()
    }
}

#[tokio::test]
async fn tim_ban_moi_qua_github_api() {
    let fake = FakeRelease::good("v999.0.0").await;
    let check = fake.updater().check().await.unwrap();
    assert_eq!(check.latest.version.to_string(), "999.0.0");
    assert!(check.newer());
    assert!(check
        .latest
        .zip_url
        .ends_with(&format!("/dl/v999.0.0/{ASSET_NAME}")));
    assert!(check.latest.sums_url.ends_with("/dl/v999.0.0/SHA256SUMS"));

    let mut out = Vec::new();
    assert!(!report_check(&check, true, &mut out), "--check không cài");
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("Có bản mới: tl 999.0.0"), "{text}");
    assert!(text.contains("tl update"), "{text}");
    let mut out = Vec::new();
    assert!(report_check(&check, false, &mut out), "có bản mới thì cài");
}

#[tokio::test]
async fn da_moi_nhat_thi_bao_va_khong_cai() {
    let fake = FakeRelease::good(&format!("v{}", teamlens::CLI_VERSION)).await;
    let check = fake.updater().check().await.unwrap();
    assert!(!check.newer());
    let mut out = Vec::new();
    assert!(!report_check(&check, false, &mut out));
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("đã là bản mới nhất"), "{text}");

    // Bản phát hành cũ hơn bản đang chạy (build dev): cũng không cài.
    let fake = FakeRelease::good("v0.0.1").await;
    let check = fake.updater().check().await.unwrap();
    assert!(!check.newer());
}

#[tokio::test]
async fn tai_kiem_hash_va_giai_nen() {
    let fake = FakeRelease::good("v999.0.0").await;
    let u = fake.updater();
    let release = u.resolve().await.unwrap();
    let dir = TempDir::new().unwrap();
    let exe = u.download_verified(&release, dir.path()).await.unwrap();
    assert_eq!(exe, dir.path().join("tl.exe"));
    assert_eq!(std::fs::read(&exe).unwrap(), FAKE_EXE);
}

#[tokio::test]
async fn sha_sai_thi_dung_khong_giai_nen() {
    let zip = make_zip(&[("tl.exe", FAKE_EXE)]);
    let sums = format!("{}  {ASSET_NAME}\n", sha256_hex(b"ban khac"));
    let fake = FakeRelease::start("v999.0.0", zip, sums).await;
    let u = fake.updater();
    let release = u.resolve().await.unwrap();
    let dir = TempDir::new().unwrap();
    let err = u.download_verified(&release, dir.path()).await.unwrap_err();
    assert!(
        matches!(err, UpdateError::ChecksumMismatch { .. }),
        "{err:?}"
    );
    assert!(
        std::fs::read_dir(dir.path()).unwrap().next().is_none(),
        "hash sai thì không ghi gì ra đĩa"
    );
}

#[tokio::test]
async fn thieu_dong_sha_hoac_thieu_asset() {
    let zip = make_zip(&[("tl.exe", FAKE_EXE)]);
    let sums = format!("{}  file-khac.zip\n", sha256_hex(&zip));
    let fake = FakeRelease::start("v999.0.0", zip, sums).await;
    let u = fake.updater();
    let release = u.resolve().await.unwrap();
    let dir = TempDir::new().unwrap();
    let err = u.download_verified(&release, dir.path()).await.unwrap_err();
    assert!(matches!(err, UpdateError::MissingSum(_)), "{err:?}");

    // Release thiếu zip.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/latest"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "tag_name": "v999.0.0",
            "assets": [{ "name": SUMS_NAME, "browser_download_url": "http://x/SHA256SUMS" }]
        })))
        .mount(&server)
        .await;
    let u = Updater::new(UpdateSource {
        api_url: format!("{}/latest", server.uri()),
        base_url: None,
        version: None,
    })
    .unwrap();
    let err = u.resolve().await.unwrap_err();
    assert!(matches!(err, UpdateError::MissingAsset { .. }), "{err:?}");
}

#[tokio::test]
async fn zip_khong_co_tl_exe() {
    let zip = make_zip(&[("README.txt", b"khong co exe")]);
    let sums = format!("{}  {ASSET_NAME}\n", sha256_hex(&zip));
    let fake = FakeRelease::start("v999.0.0", zip, sums).await;
    let u = fake.updater();
    let release = u.resolve().await.unwrap();
    let dir = TempDir::new().unwrap();
    let err = u.download_verified(&release, dir.path()).await.unwrap_err();
    assert!(matches!(err, UpdateError::Extract(_)), "{err:?}");
}

#[tokio::test]
async fn chua_co_release_hoac_loi_mang() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let u = Updater::new(UpdateSource {
        api_url: format!("{}/latest", server.uri()),
        base_url: None,
        version: None,
    })
    .unwrap();
    assert!(matches!(u.check().await, Err(UpdateError::NoRelease)));

    // Cổng không có ai nghe: lỗi mạng, không panic.
    let u = Updater::new(UpdateSource {
        api_url: "http://127.0.0.1:9/latest".into(),
        base_url: None,
        version: None,
    })
    .unwrap();
    let err = u.check().await.unwrap_err();
    assert!(matches!(err, UpdateError::Network { .. }), "{err:?}");
    let e = err.into_app_error();
    assert!(e.hint().unwrap().contains("tl update"));
}

#[tokio::test]
async fn base_url_va_version_khong_goi_github_api() {
    let zip = make_zip(&[("tl.exe", FAKE_EXE)]);
    let sums = format!("{}  {ASSET_NAME}\n", sha256_hex(&zip));
    let fake = FakeRelease::start("v999.0.0", zip, sums).await;
    let u = Updater::new(UpdateSource::from_vars(|k| match k {
        "TL_UPDATE_BASE_URL" => Some(format!("{}/dl/v999.0.0/", fake.server.uri())),
        _ => None,
    }))
    .unwrap();
    let release = u.resolve().await.unwrap();
    assert_eq!(release.version.to_string(), "999.0.0");
    let dir = TempDir::new().unwrap();
    u.download_verified(&release, dir.path()).await.unwrap();
    let api_calls = fake
        .server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.url.path().contains("/releases/latest"))
        .count();
    assert_eq!(api_calls, 0, "đặt base URL thì không gọi GitHub API");
}

#[tokio::test]
async fn kiem_xong_ghi_state_va_status_hien_ban_moi() {
    let fake = FakeRelease::good("v999.0.0").await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    check_and_record(&ctx, &fake.updater()).await.unwrap();

    let report = status::collect(&ctx).await.unwrap();
    assert_eq!(report.cli_version, teamlens::CLI_VERSION);
    let mut out = Vec::new();
    status::run_with(
        &ctx,
        status::StatusArgs { json: true },
        &no_sources(),
        &mut out,
    )
    .await
    .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["update"]["latestVersion"], "999.0.0");
    assert_eq!(v["update"]["updateAvailable"], true);
    assert!(v["update"]["checkedAt"].is_string());

    let mut out = Vec::new();
    status::run_with(
        &ctx,
        status::StatusArgs { json: false },
        &no_sources(),
        &mut out,
    )
    .await
    .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert!(
        text.contains(&format!("tl {}, có bản mới 999.0.0", teamlens::CLI_VERSION)),
        "{text}"
    );
}

fn no_sources() -> teamlens::sync::Sources {
    teamlens::sync::Sources {
        adapters: Vec::new(),
        prepare: Default::default(),
    }
}

fn state_db(ctx: &AppContext) -> std::path::PathBuf {
    state_path(&ctx.config_path)
}

fn data_dir(ctx: &AppContext) -> &Path {
    ctx.config_path.parent().unwrap()
}

#[tokio::test]
async fn daemon_tu_kiem_da_moi_nhat_hen_24h() {
    let fake = FakeRelease::good(&format!("v{}", teamlens::CLI_VERSION)).await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let now = Utc::now();
    let mut sched = AutoSchedule::load(None, true, now);
    let outcome = auto::run_once(
        &fake.updater(),
        &mut sched,
        &state_db(&ctx),
        data_dir(&ctx),
        now,
    )
    .await;
    assert!(matches!(outcome, AutoOutcome::UpToDate(_)), "{outcome:?}");
    assert_eq!(sched.next_at, now + chrono::Duration::hours(24));
    let db = StateDb::open(&state_db(&ctx)).unwrap();
    let back = AutoSchedule::load(Some(&db), true, now);
    assert_eq!(back.next_at, sched.next_at, "lịch lưu trong state.db");
    assert!(!auto::read_info(&db).update_available);
}

#[tokio::test]
async fn daemon_tu_cap_nhat_sha_sai_giu_ban_cu_va_backoff() {
    let zip = make_zip(&[("tl.exe", FAKE_EXE)]);
    let sums = format!("{}  {ASSET_NAME}\n", "0".repeat(64));
    let fake = FakeRelease::start("v999.0.0", zip, sums).await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let exe_before = std::fs::read(std::env::current_exe().unwrap()).unwrap();
    let now = Utc::now();
    let mut sched = AutoSchedule::load(None, true, now);
    let outcome = auto::run_once(
        &fake.updater(),
        &mut sched,
        &state_db(&ctx),
        data_dir(&ctx),
        now,
    )
    .await;
    let AutoOutcome::Failed(msg) = outcome else {
        panic!("phải lỗi: {outcome:?}");
    };
    assert!(msg.contains("không khớp SHA256SUMS"), "{msg}");
    assert_eq!(sched.failures, 1);
    assert_eq!(sched.next_at, now + chrono::Duration::minutes(15));
    let db = StateDb::open(&state_db(&ctx)).unwrap();
    let info = auto::read_info(&db);
    assert!(info.last_error.unwrap().contains("SHA256SUMS"));
    assert_eq!(info.latest_version.as_deref(), Some("999.0.0"));
    assert_eq!(
        std::fs::read(std::env::current_exe().unwrap()).unwrap(),
        exe_before,
        "binary đang chạy không bị đụng"
    );
    // Thư mục tạm đã dọn.
    let leftovers: Vec<_> = std::fs::read_dir(data_dir(&ctx))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("update-"))
        .collect();
    assert!(leftovers.is_empty());
}

#[tokio::test]
async fn daemon_tu_cap_nhat_ban_tai_ve_hong_khong_cai() {
    // Hash khớp nhưng tl.exe không chạy được: dừng ở bước chạy thử, không thay file.
    let fake = FakeRelease::good("v999.0.0").await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let now = Utc::now();
    let mut sched = AutoSchedule::load(None, true, now);
    let outcome = auto::run_once(
        &fake.updater(),
        &mut sched,
        &state_db(&ctx),
        data_dir(&ctx),
        now,
    )
    .await;
    assert!(
        matches!(&outcome, AutoOutcome::Failed(m) if m.contains("không chạy được")),
        "{outcome:?}"
    );
}
