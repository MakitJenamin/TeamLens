//! Test `tl join <link mời>`, `tl open` và chốt đồng ý `may_send` với mock server (wiremock).
//! Credential store dùng `MemoryCredentialStore`, không đụng Credential Manager thật;
//! câu trả lời bàn phím đưa vào qua `Cursor`.

use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::json;
use teamlens::commands::join::{self, JoinArgs, JoinOutcome};
use teamlens::commands::open::{self, OpenArgs};
use teamlens::commands::status;
use teamlens::config::Config;
use teamlens::context::AppContext;
use teamlens::error::AppError;
use teamlens::sync::consent_gate;
use tempfile::TempDir;
use tl_adapters::claude_code::ClaudeCodeAdapter;
use tl_adapters::Adapter;
use tl_platform::MemoryCredentialStore;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Match, Mock, MockServer, Request, ResponseTemplate};

const CODE: &str = "Zm9vYmFyMTIzNDU2Nzg5MA";
const TOKEN: &str = "tld_join_new_token";
const OLD_TOKEN: &str = "tld_old_token";

fn test_ctx(dir: &TempDir) -> AppContext {
    AppContext {
        config_path: dir.path().join("teamlens").join("config.toml"),
        credentials: Box::new(MemoryCredentialStore::new()),
        poll_unit: Duration::from_millis(1),
        open_browser: |_| panic!("test không được mở trình duyệt"),
    }
}

fn link(server: &MockServer) -> String {
    format!("{}/i/{CODE}", server.uri())
}

fn args(url: &str) -> JoinArgs {
    JoinArgs {
        invite_url: Some(url.to_owned()),
        name: None,
        yes: false,
        backfill: false,
        no_backfill: false,
    }
}

fn preview_body(version: &str) -> serde_json::Value {
    json!({
        "serverUrl": "http://localhost:3120",
        "project": { "id": "p1", "name": "TeamLens", "slug": "teamlens" },
        "repoPatterns": ["github.com/acme/shop", "github.com/acme/*"],
        "consent": { "version": version, "text": format!("Văn bản đồng ý {version}.\nDòng hai.") },
        "expiresAt": "2026-12-04T08:00:00.000Z"
    })
}

fn join_result(token: Option<&str>) -> serde_json::Value {
    let mut v = json!({
        "userId": "u1",
        "deviceId": "d1",
        "role": "member",
        "project": { "id": "p1", "name": "TeamLens", "slug": "teamlens",
                     "repoPatterns": ["github.com/acme/shop"] }
    });
    if let Some(t) = token {
        v["accessToken"] = json!(t);
    }
    v
}

fn api_error(status: u16, code: &str) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_json(json!({ "error": code, "message": "mô tả" }))
}

/// Request không có header `Authorization`.
struct NoAuth;
impl Match for NoAuth {
    fn matches(&self, req: &Request) -> bool {
        !req.headers.contains_key("authorization")
    }
}

async fn mount_preview(server: &MockServer, version: &str) {
    Mock::given(method("GET"))
        .and(path(format!("/agent/v1/invites/{CODE}")))
        .and(NoAuth)
        .respond_with(ResponseTemplate::new(200).set_body_json(preview_body(version)))
        .mount(server)
        .await;
}

/// Claude Code giả có `n` file session cũ.
fn fake_history(dir: &TempDir, n: usize) -> ClaudeCodeAdapter {
    let project = dir.path().join("claude/projects/C--repo");
    std::fs::create_dir_all(&project).unwrap();
    for i in 0..n {
        std::fs::write(project.join(format!("s{i}.jsonl")), "{}\n").unwrap();
    }
    ClaudeCodeAdapter::new(dir.path().join("claude"))
}

async fn run_join(
    ctx: &AppContext,
    args: JoinArgs,
    adapters: &[&dyn Adapter],
    input: &str,
) -> (Result<JoinOutcome, AppError>, String) {
    let mut out = Vec::new();
    let mut input = Cursor::new(input.as_bytes().to_vec());
    let r = join::run_with(ctx, args, adapters, &mut input, &mut out).await;
    (r, String::from_utf8(out).unwrap())
}

fn requests_to(reqs: &[Request], p: &str) -> usize {
    reqs.iter().filter(|r| r.url.path() == p).count()
}

#[tokio::test]
async fn join_thanh_cong_luu_token_server_va_dong_y() {
    let server = MockServer::start().await;
    mount_preview(&server, "2026-11-26").await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/join"))
        .and(NoAuth)
        .and(body_partial_json(json!({
            "code": CODE,
            "name": "Nguyễn An",
            "os": std::env::consts::OS,
            "cliVersion": teamlens::CLI_VERSION,
            "consent": { "textVersion": "2026-11-26", "backfill": true }
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(join_result(Some(TOKEN))))
        .expect(1)
        .mount(&server)
        .await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    assert!(!consent_gate::may_send(&ctx), "chưa join thì chưa được gửi");

    let cc = fake_history(&dir, 3);
    let (r, printed) = run_join(&ctx, args(&link(&server)), &[&cc], "Nguyễn An\n\n").await;
    let outcome = r.expect("join phải thành công");
    assert!(outcome.new_token);
    assert!(outcome.backfill);
    assert_eq!(outcome.server_url, server.uri());
    assert_eq!(outcome.project_slug, "teamlens");

    // Token vào credential store, config có server + bản đồng ý, không có token.
    assert_eq!(
        ctx.credentials.get_token(&server.uri()).unwrap().as_deref(),
        Some(TOKEN)
    );
    let cfg = Config::load(&ctx.config_path).unwrap();
    assert_eq!(cfg.server_url.as_deref(), Some(server.uri().as_str()));
    let consent = cfg.consent.as_ref().unwrap();
    assert_eq!(consent.server_url, server.uri());
    assert_eq!(consent.projects[0].project_id, "p1");
    assert_eq!(consent.projects[0].text_version, "2026-11-26");
    assert!(consent.projects[0].backfill);
    let raw = std::fs::read_to_string(&ctx.config_path).unwrap();
    assert!(!raw.contains(TOKEN), "token không được ghi ra file config");
    assert!(!raw.contains(CODE), "mã mời không được ghi ra file config");
    assert!(consent_gate::may_send(&ctx), "join xong thì được gửi");

    // Màn hình đồng ý có đủ thông tin.
    for needle in [
        "http://localhost:3120",
        "TeamLens (teamlens)",
        "github.com/acme/*",
        "phiên bản 2026-11-26",
        "Văn bản đồng ý 2026-11-26.",
        "Dòng hai.",
        "3 file session cũ",
        "Enter: có",
        "Gửi ngay: `tl sync`.",
    ] {
        assert!(printed.contains(needle), "thiếu {needle:?}:\n{printed}");
    }
}

#[tokio::test]
async fn bo_ngang_khi_hoi_thi_khong_goi_join_khong_luu_gi() {
    let server = MockServer::start().await;
    mount_preview(&server, "2026-11-26").await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/join"))
        .respond_with(ResponseTemplate::new(201).set_body_json(join_result(Some(TOKEN))))
        .expect(0)
        .mount(&server)
        .await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    // Bỏ ngang (Ctrl+C, stdin đóng) ở câu hỏi tên hoặc backfill: không tham gia.
    let cc = fake_history(&dir, 1);
    for input in ["", "An\n"] {
        let (r, _) = run_join(&ctx, args(&link(&server)), &[&cc], input).await;
        assert!(r.is_err());
    }
    assert_eq!(ctx.credentials.get_token(&server.uri()).unwrap(), None);
    assert!(!ctx.config_path.exists(), "từ chối thì không ghi config");
    assert!(!consent_gate::may_send(&ctx));
    server.verify().await;
}

#[tokio::test]
async fn link_het_han_va_khong_ton_tai() {
    for (status, code, needle) in [
        (410, "invite_expired", "hết hạn"),
        (410, "invite_used_up", "hết lượt"),
        (410, "invite_revoked", "thu hồi"),
        (404, "invite_not_found", "Không tìm thấy"),
    ] {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/agent/v1/invites/{CODE}")))
            .respond_with(api_error(status, code))
            .mount(&server)
            .await;

        let dir = TempDir::new().unwrap();
        let ctx = test_ctx(&dir);
        let (r, _) = run_join(&ctx, args(&link(&server)), &[], "").await;
        let e = r.unwrap_err();
        assert!(e.to_string().contains(needle), "{code}: {e}");
        assert!(e.hint().unwrap().contains("link mời mới"), "{code}");
        assert!(!ctx.config_path.exists());
    }
}

#[tokio::test]
async fn join_het_han_giua_chung_va_bi_gioi_han() {
    let server = MockServer::start().await;
    mount_preview(&server, "v1").await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/join"))
        .respond_with(api_error(410, "invite_expired"))
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let (r, _) = run_join(&ctx, args(&link(&server)), &[], "An\nyes\n").await;
    assert!(r.unwrap_err().to_string().contains("hết hạn"));
    assert_eq!(ctx.credentials.get_token(&server.uri()).unwrap(), None);

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/agent/v1/invites/{CODE}")))
        .respond_with(api_error(429, "rate_limited"))
        .mount(&server)
        .await;
    let (r, _) = run_join(&ctx, args(&link(&server)), &[], "").await;
    let e = r.unwrap_err();
    assert!(e.to_string().contains("giới hạn"), "{e}");
}

#[tokio::test]
async fn consent_outdated_thi_xem_lai_va_hoi_lai() {
    let server = MockServer::start().await;
    // Lần xem trước đầu trả v1, các lần sau trả v2.
    Mock::given(method("GET"))
        .and(path(format!("/agent/v1/invites/{CODE}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(preview_body("v1")))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    mount_preview(&server, "v2").await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/join"))
        .and(body_partial_json(
            json!({ "consent": { "textVersion": "v1" } }),
        ))
        .respond_with(api_error(409, "consent_outdated"))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/join"))
        .and(body_partial_json(
            json!({ "name": "An", "consent": { "textVersion": "v2", "backfill": false } }),
        ))
        .respond_with(ResponseTemplate::new(201).set_body_json(join_result(Some(TOKEN))))
        .expect(1)
        .mount(&server)
        .await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let cc = fake_history(&dir, 1);
    // Tên và backfill chỉ hỏi một lần; văn bản mới thì hỏi lại, Enter là đồng ý.
    let (r, printed) = run_join(&ctx, args(&link(&server)), &[&cc], "An\nno\n\n").await;
    let outcome = r.expect("đồng ý lại văn bản mới phải thành công");
    assert_eq!(outcome.text_version, "v2");
    assert!(printed.contains("vừa thay đổi"), "{printed}");
    assert!(printed.contains("Văn bản đồng ý v2."), "{printed}");
    let cfg = Config::load(&ctx.config_path).unwrap();
    assert_eq!(cfg.consent.unwrap().projects[0].text_version, "v2");
    server.verify().await;
}

#[tokio::test]
async fn consent_outdated_roi_tu_choi_thi_khong_luu() {
    let server = MockServer::start().await;
    mount_preview(&server, "v1").await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/join"))
        .respond_with(api_error(409, "consent_outdated"))
        .expect(1)
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let (r, _) = run_join(&ctx, args(&link(&server)), &[], "An\nno\n").await;
    assert!(r.unwrap_err().to_string().contains("hủy"));
    assert!(!ctx.config_path.exists());
    server.verify().await;
}

#[tokio::test]
async fn may_da_co_token_giu_token_cu() {
    let server = MockServer::start().await;
    mount_preview(&server, "2026-11-26").await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/whoami"))
        .and(header(
            "authorization",
            format!("Bearer {OLD_TOKEN}").as_str(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user": { "id": "u1", "email": null, "name": "Member One" },
            "role": "member",
            "device": { "id": "d1", "name": "MAY-TEST" },
            "projects": []
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/join"))
        .and(header(
            "authorization",
            format!("Bearer {OLD_TOKEN}").as_str(),
        ))
        .and(body_partial_json(json!({ "name": "Member One" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(join_result(None)))
        .expect(1)
        .mount(&server)
        .await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    ctx.credentials.set_token(&server.uri(), OLD_TOKEN).unwrap();
    let mut a = args(&link(&server));
    a.no_backfill = true;
    // Không hỏi tên (đã có), không hỏi backfill (cờ): không hỏi gì.
    let (r, printed) = run_join(&ctx, a, &[], "").await;
    let outcome = r.expect("thêm project cho máy đã có token phải thành công");
    assert!(!outcome.new_token);
    assert!(!outcome.backfill);
    assert!(printed.contains("đã tham gia"), "{printed}");
    assert_eq!(
        ctx.credentials.get_token(&server.uri()).unwrap().as_deref(),
        Some(OLD_TOKEN)
    );
    assert!(consent_gate::may_send(&ctx));
    server.verify().await;
}

#[tokio::test]
async fn token_cu_bi_thu_hoi_thi_tham_gia_nhu_may_moi() {
    let server = MockServer::start().await;
    mount_preview(&server, "2026-11-26").await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/whoami"))
        .respond_with(api_error(401, "invalid_token"))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/join"))
        .and(NoAuth)
        .respond_with(ResponseTemplate::new(201).set_body_json(join_result(Some(TOKEN))))
        .expect(1)
        .mount(&server)
        .await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    ctx.credentials.set_token(&server.uri(), OLD_TOKEN).unwrap();
    let (r, _) = run_join(&ctx, args(&link(&server)), &[], "An\nyes\n").await;
    assert!(r.unwrap().new_token);
    assert_eq!(
        ctx.credentials.get_token(&server.uri()).unwrap().as_deref(),
        Some(TOKEN)
    );
    server.verify().await;
}

#[tokio::test]
async fn co_khong_tuong_tac() {
    let server = MockServer::start().await;
    mount_preview(&server, "2026-11-26").await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/join"))
        .and(body_partial_json(json!({
            "name": "Bot CI",
            "consent": { "textVersion": "2026-11-26", "backfill": true }
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(join_result(Some(TOKEN))))
        .expect(1)
        .mount(&server)
        .await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let mut a = args(&link(&server));
    a.name = Some("Bot CI".into());
    a.yes = true;
    a.backfill = true;
    // Không có gì trên stdin: không được hỏi gì.
    let (r, _) = run_join(&ctx, a, &[], "").await;
    r.expect("cờ không tương tác phải đủ để tham gia");
    server.verify().await;
}

#[tokio::test]
async fn khong_co_stdin_thi_khong_tham_gia() {
    let server = MockServer::start().await;
    mount_preview(&server, "2026-11-26").await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let (r, _) = run_join(&ctx, args(&link(&server)), &[], "").await;
    assert!(r.is_err());
    let reqs = server.received_requests().await.unwrap();
    assert_eq!(requests_to(&reqs, "/agent/v1/join"), 0);
}

#[tokio::test]
async fn link_sai_hoac_thieu_khong_goi_mang() {
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let (r, _) = run_join(&ctx, args("teamlens.congty.com/i/abc"), &[], "").await;
    let e = r.unwrap_err();
    assert!(
        e.to_string().contains("Link mời không đúng định dạng"),
        "{e}"
    );

    let mut a = args("");
    a.invite_url = None;
    let (r, _) = run_join(&ctx, a, &[], "").await;
    let e = r.unwrap_err();
    assert!(e.to_string().contains("Thiếu link mời"), "{e}");
    assert!(e
        .hint()
        .unwrap()
        .contains("tl join https://<server>/i/<mã>"));
}

#[tokio::test]
async fn status_hien_trang_thai_dong_y_sau_join() {
    let server = MockServer::start().await;
    mount_preview(&server, "2026-11-26").await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/join"))
        .respond_with(ResponseTemplate::new(201).set_body_json(join_result(Some(TOKEN))))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/whoami"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user": { "id": "u1", "email": null, "name": "An" },
            "role": "member",
            "device": { "id": "d1", "name": "MAY-TEST" },
            "projects": []
        })))
        .mount(&server)
        .await;

    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);

    let mut out = Vec::new();
    status::run(&ctx, status::StatusArgs { json: false }, &mut out)
        .await
        .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("Đồng ý:     chưa"), "{text}");

    let (r, _) = run_join(&ctx, args(&link(&server)), &[], "An\nyes\n").await;
    r.unwrap();

    let mut out = Vec::new();
    status::run(&ctx, status::StatusArgs { json: false }, &mut out)
        .await
        .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert!(
        text.contains("TeamLens (teamlens): văn bản 2026-11-26"),
        "{text}"
    );
    assert!(text.contains("chỉ gửi session từ lúc đồng ý"), "{text}");

    let report = status::collect(&ctx).await.unwrap();
    let v = serde_json::to_value(&report).unwrap();
    assert_eq!(v["consent"]["projects"][0]["text_version"], "2026-11-26");
}

async fn mount_web_login(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/agent/v1/web-login"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "url": "http://localhost:3120/auth/cli?ticket=abc",
            "expiresIn": 60
        })))
        .expect(1)
        .mount(server)
        .await;
}

fn joined_ctx(dir: &TempDir, server: &MockServer) -> AppContext {
    let ctx = test_ctx(dir);
    ctx.save_config(&Config {
        server_url: Some(server.uri()),
        ..Default::default()
    })
    .unwrap();
    ctx.credentials.set_token(&server.uri(), TOKEN).unwrap();
    ctx
}

#[tokio::test]
async fn open_no_browser_in_link() {
    let server = MockServer::start().await;
    mount_web_login(&server).await;
    let dir = TempDir::new().unwrap();
    let ctx = joined_ctx(&dir, &server);
    let mut out = Vec::new();
    let url = open::run(&ctx, OpenArgs { no_browser: true }, &mut out)
        .await
        .unwrap();
    assert_eq!(url, "http://localhost:3120/auth/cli?ticket=abc");
    let text = String::from_utf8(out).unwrap();
    assert!(
        text.contains("http://localhost:3120/auth/cli?ticket=abc"),
        "{text}"
    );
    assert!(text.contains("60 giây"), "{text}");
    server.verify().await;
}

static OPENED: AtomicBool = AtomicBool::new(false);

#[tokio::test]
async fn open_mo_trinh_duyet() {
    let server = MockServer::start().await;
    mount_web_login(&server).await;
    let dir = TempDir::new().unwrap();
    let mut ctx = joined_ctx(&dir, &server);
    ctx.open_browser = |url| {
        assert_eq!(url, "http://localhost:3120/auth/cli?ticket=abc");
        OPENED.store(true, Ordering::SeqCst);
        true
    };
    let mut out = Vec::new();
    open::run(&ctx, OpenArgs { no_browser: false }, &mut out)
        .await
        .unwrap();
    assert!(OPENED.load(Ordering::SeqCst));
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("Đã mở dashboard"), "{text}");
    assert!(
        !text.contains("ticket="),
        "đã mở trình duyệt thì không in link"
    );
}

#[tokio::test]
async fn open_chua_join_hoac_token_bi_thu_hoi() {
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let e = open::run(&ctx, OpenArgs { no_browser: true }, &mut Vec::new())
        .await
        .unwrap_err();
    assert!(e.hint().unwrap().contains("tl join"), "{e}");

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/web-login"))
        .respond_with(api_error(401, "invalid_token"))
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = joined_ctx(&dir, &server);
    let e = open::run(&ctx, OpenArgs { no_browser: true }, &mut Vec::new())
        .await
        .unwrap_err();
    assert!(e.to_string().contains("không còn hiệu lực"), "{e}");
    assert!(e.hint().unwrap().contains("tl join"));
}
