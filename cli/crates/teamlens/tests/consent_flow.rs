//! Test `tl consent` (xem, đồng ý lại) và `tl consent revoke` với mock server (wiremock).
//! Credential store là `MemoryCredentialStore`; câu trả lời bàn phím đưa vào qua `Cursor`.

use std::collections::HashMap;
use std::io::Cursor;
use std::time::Duration;

use chrono::{TimeZone, Utc};
use serde_json::json;
use teamlens::commands::consent::{self, ConsentArgs, ConsentOutcome};
use teamlens::config::Config;
use teamlens::consent::{self as local_consent, ProjectConsent};
use teamlens::context::AppContext;
use teamlens::error::AppError;
use teamlens::queue;
use teamlens::state::{state_path, StateDb};
use teamlens::sync::consent_gate;
use tempfile::TempDir;
use tl_core::session::{AgentKind, Role, Session, SessionEnvelope, Turn, TurnKind};
use tl_platform::MemoryCredentialStore;
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TOKEN: &str = "tld_consent_flow_token";

fn test_ctx(dir: &TempDir) -> AppContext {
    AppContext {
        config_path: dir.path().join("teamlens").join("config.toml"),
        credentials: Box::new(MemoryCredentialStore::new()),
        poll_unit: Duration::from_millis(1),
        open_browser: |_| panic!("test không được mở trình duyệt"),
    }
}

fn args(yes: bool, backfill: bool, no_backfill: bool) -> ConsentArgs {
    ConsentArgs {
        command: None,
        yes,
        backfill,
        no_backfill,
    }
}

fn status_body(
    version: &str,
    status: &str,
    accepted: Option<&str>,
    backfill: Option<bool>,
) -> serde_json::Value {
    json!({
        "textVersion": version,
        "text": format!("Văn bản đồng ý {version}.\nDòng hai."),
        "status": status,
        "acceptedVersion": accepted,
        "backfill": backfill,
        "grantedAt": accepted.map(|_| "2026-11-26T08:00:00.000Z"),
        "revokedAt": if status == "revoked" { json!("2026-11-27T09:00:00.000Z") } else { json!(null) }
    })
}

/// Máy đã tham gia `server` với bản đồng ý `local_version`, có token.
fn joined(ctx: &AppContext, server: &MockServer, local_version: &str, backfill: bool) {
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
            text_version: local_version.into(),
            backfill,
            accepted_at: Utc.with_ymd_and_hms(2026, 11, 26, 8, 0, 0).unwrap(),
        },
    );
    ctx.save_config(&config).unwrap();
    ctx.credentials.set_token(&url, TOKEN).unwrap();
}

async fn mount_get(server: &MockServer, body: serde_json::Value) {
    Mock::given(method("GET"))
        .and(path("/agent/v1/consent"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(server)
        .await;
}

fn text(out: Vec<u8>) -> String {
    String::from_utf8(out).unwrap()
}

#[tokio::test]
async fn da_dong_y_ban_hien_hanh_thi_khong_goi_post() {
    let server = MockServer::start().await;
    mount_get(
        &server,
        status_body("v2", "granted", Some("v2"), Some(false)),
    )
    .await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server, "v2", false);

    let mut out = Vec::new();
    let outcome = consent::run_with(
        &ctx,
        &args(false, false, false),
        &[],
        &mut Cursor::new(""),
        &mut out,
    )
    .await
    .unwrap();
    assert_eq!(outcome, ConsentOutcome::UpToDate);
    let printed = text(out);
    assert!(
        printed.contains("đã đồng ý bản văn bản hiện hành"),
        "{printed}"
    );
    assert!(printed.contains("Văn bản đồng ý v2."), "{printed}");
    assert!(printed.contains("không cần làm gì thêm"), "{printed}");
}

#[tokio::test]
async fn van_ban_doi_phien_ban_thi_dong_y_lai_va_giu_lua_chon_cu() {
    let server = MockServer::start().await;
    mount_get(
        &server,
        status_body("v2", "outdated", Some("v1"), Some(true)),
    )
    .await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .and(body_json(
            json!({ "action": "grant", "textVersion": "v2", "backfill": true }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(status_body(
            "v2",
            "granted",
            Some("v2"),
            Some(true),
        )))
        .expect(1)
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server, "v1", true);

    let mut out = Vec::new();
    let outcome = consent::run_with(
        &ctx,
        &args(false, false, false),
        &[],
        &mut Cursor::new("yes\n"),
        &mut out,
    )
    .await
    .unwrap();
    assert_eq!(
        outcome,
        ConsentOutcome::Granted {
            text_version: "v2".into(),
            backfill: true
        }
    );
    let printed = text(out);
    assert!(printed.contains("cần đồng ý lại"), "{printed}");
    assert!(printed.contains("Giữ lựa chọn trước đây"), "{printed}");
    let cfg = ctx.load_config().unwrap();
    let state = local_consent::current(&cfg).unwrap();
    assert_eq!(state.projects[0].text_version, "v2");
    assert!(state.projects[0].backfill);
    assert!(
        state.projects[0].accepted_at > Utc.with_ymd_and_hms(2026, 11, 27, 0, 0, 0).unwrap(),
        "thời điểm đồng ý phải được cập nhật"
    );
}

#[tokio::test]
async fn da_rut_dong_y_thi_hoi_lai_backfill_va_gui_lai_duoc() {
    let server = MockServer::start().await;
    mount_get(&server, status_body("v2", "revoked", None, None)).await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .and(body_json(
            json!({ "action": "grant", "textVersion": "v2", "backfill": true }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(status_body(
            "v2",
            "granted",
            Some("v2"),
            Some(true),
        )))
        .expect(1)
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server, "v2", false);
    let mut cfg = ctx.load_config().unwrap();
    assert!(local_consent::revoke_local(&mut cfg, Utc::now()));
    ctx.save_config(&cfg).unwrap();
    assert!(!consent_gate::may_send(&ctx));

    let mut out = Vec::new();
    // `--backfill` bỏ qua câu hỏi; chỉ còn câu gõ `yes`.
    let outcome = consent::run_with(
        &ctx,
        &args(false, true, false),
        &[],
        &mut Cursor::new("yes\n"),
        &mut out,
    )
    .await
    .unwrap();
    assert!(matches!(
        outcome,
        ConsentOutcome::Granted { backfill: true, .. }
    ));
    let printed = text(out);
    assert!(printed.contains("đã rút đồng ý"), "{printed}");
    assert!(consent_gate::may_send(&ctx), "đồng ý lại thì gửi được");
    let cfg = ctx.load_config().unwrap();
    assert!(!local_consent::stored(&cfg).unwrap().is_revoked());
}

#[tokio::test]
async fn tu_choi_thi_khong_goi_post_va_khong_doi_gi() {
    let server = MockServer::start().await;
    mount_get(
        &server,
        status_body("v2", "outdated", Some("v1"), Some(false)),
    )
    .await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server, "v1", false);
    let before = ctx.load_config().unwrap();

    let mut out = Vec::new();
    let err = consent::run_with(
        &ctx,
        &args(false, false, false),
        &[],
        &mut Cursor::new("no\n"),
        &mut out,
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("Đã hủy"), "{err}");
    assert!(text(out).contains("vẫn không gửi gì"));
    assert_eq!(ctx.load_config().unwrap(), before);
}

#[tokio::test]
async fn co_yes_va_no_backfill_thi_khong_can_tuong_tac() {
    let server = MockServer::start().await;
    mount_get(&server, status_body("v2", "revoked", None, None)).await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .and(body_json(
            json!({ "action": "grant", "textVersion": "v2", "backfill": false }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(status_body(
            "v2",
            "granted",
            Some("v2"),
            Some(false),
        )))
        .expect(1)
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server, "v2", false);

    let mut out = Vec::new();
    // Không có dòng nhập nào: nếu code còn hỏi thì lỗi "không có câu trả lời".
    let outcome = consent::run_with(
        &ctx,
        &args(true, false, true),
        &[],
        &mut Cursor::new(""),
        &mut out,
    )
    .await
    .unwrap();
    assert!(matches!(
        outcome,
        ConsentOutcome::Granted {
            backfill: false,
            ..
        }
    ));
}

#[tokio::test]
async fn consent_outdated_thi_doc_lai_van_ban_moi_va_hoi_lai() {
    let server = MockServer::start().await;
    // Lần đọc đầu thấy v2, lần sau thấy v3.
    Mock::given(method("GET"))
        .and(path("/agent/v1/consent"))
        .respond_with(ResponseTemplate::new(200).set_body_json(status_body(
            "v2",
            "outdated",
            Some("v1"),
            Some(false),
        )))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    mount_get(
        &server,
        status_body("v3", "outdated", Some("v1"), Some(false)),
    )
    .await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .and(body_json(
            json!({ "action": "grant", "textVersion": "v2", "backfill": false }),
        ))
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({
            "error": "consent_outdated",
            "message": "Văn bản đồng ý đã thay đổi, hãy xem lại và đồng ý lại."
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .and(body_json(
            json!({ "action": "grant", "textVersion": "v3", "backfill": false }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(status_body(
            "v3",
            "granted",
            Some("v3"),
            Some(false),
        )))
        .expect(1)
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server, "v1", false);

    let mut out = Vec::new();
    let outcome = consent::run_with(
        &ctx,
        &args(false, false, false),
        &[],
        &mut Cursor::new("yes\nyes\n"),
        &mut out,
    )
    .await
    .unwrap();
    assert!(matches!(
        outcome,
        ConsentOutcome::Granted { ref text_version, .. } if text_version == "v3"
    ));
    let printed = text(out);
    assert!(printed.contains("vừa thay đổi"), "{printed}");
    assert!(printed.contains("Văn bản đồng ý v3."), "{printed}");
    let cfg = ctx.load_config().unwrap();
    assert_eq!(
        local_consent::current(&cfg).unwrap().projects[0].text_version,
        "v3"
    );
}

#[tokio::test]
async fn may_chua_tham_gia_thi_bao_loi_co_goi_y() {
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let err = consent::run_with(
        &ctx,
        &args(false, false, false),
        &[],
        &mut Cursor::new(""),
        &mut Vec::new(),
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("chưa tham gia"), "{err}");
    assert!(err.hint().unwrap().contains("tl join"));
}

#[tokio::test]
async fn token_bi_thu_hoi_thi_goi_y_tham_gia_lai() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/consent"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "error": "invalid_token",
            "message": "Token thiết bị không hợp lệ hoặc đã bị thu hồi."
        })))
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server, "v1", false);

    let err = consent::run_with(
        &ctx,
        &args(false, false, false),
        &[],
        &mut Cursor::new(""),
        &mut Vec::new(),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Api(_)));
    assert!(err.hint().unwrap().contains("tl join"));
}

#[tokio::test]
async fn server_noi_da_dong_y_nhung_may_khong_luu_project_thi_bao_tham_gia_lai() {
    let server = MockServer::start().await;
    mount_get(
        &server,
        status_body("v2", "granted", Some("v2"), Some(false)),
    )
    .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let url = server.uri();
    ctx.save_config(&Config {
        server_url: Some(url.clone()),
        ..Default::default()
    })
    .unwrap();
    ctx.credentials.set_token(&url, TOKEN).unwrap();

    let err = consent::run_with(
        &ctx,
        &args(false, false, false),
        &[],
        &mut Cursor::new(""),
        &mut Vec::new(),
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("chưa lưu project nào"), "{err}");
}

// ---- tl consent revoke ----

fn envelope() -> SessionEnvelope {
    let ts = Utc.with_ymd_and_hms(2026, 11, 27, 9, 0, 0).unwrap();
    let mut turn = Turn::new(0, Role::User, TurnKind::Prompt, ts);
    turn.text = Some("nội dung đã che".into());
    SessionEnvelope {
        session: Session {
            source_id: "claude_code:abc".into(),
            agent: AgentKind::ClaudeCode,
            agent_version: None,
            repo_remote: "github.com/acme/shop".into(),
            branch: None,
            cwd_relative: Some(String::new()),
            started_at: ts,
            ended_at: None,
            parent_source_id: None,
            permission_mode: None,
            instruction_files: None,
        },
        turns: vec![turn],
    }
}

/// Đặt sẵn một batch chờ gửi trong `state.db`; trả số batch đang chờ.
fn seed_pending_batch(ctx: &AppContext) -> u64 {
    let mut db = StateDb::open(&state_path(&ctx.config_path)).unwrap();
    queue::enqueue_envelopes(
        &mut db,
        vec![envelope()],
        &HashMap::new(),
        vec![],
        8 * 1024 * 1024,
        500 * 1024 * 1024,
    )
    .unwrap();
    queue::queue_stats(&db).unwrap().pending_batches
}

fn pending(ctx: &AppContext) -> u64 {
    let db = StateDb::open(&state_path(&ctx.config_path)).unwrap();
    queue::queue_stats(&db).unwrap().pending_batches
}

fn revoke_args(yes: bool) -> ConsentArgs {
    ConsentArgs {
        command: Some(consent::ConsentCommand::Revoke),
        yes,
        backfill: false,
        no_backfill: false,
    }
}

#[tokio::test]
async fn rut_dong_y_dung_ca_ba_viec_dung_gui_xoa_hang_doi_bao_server() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .and(body_json(json!({ "action": "revoke" })))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(status_body("v2", "revoked", None, None)),
        )
        .expect(1)
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server, "v2", false);
    assert_eq!(seed_pending_batch(&ctx), 1);
    assert!(consent_gate::may_send(&ctx));

    let mut out = Vec::new();
    let outcome = consent::revoke_with(&ctx, &revoke_args(true), &mut Cursor::new(""), &mut out)
        .await
        .unwrap();
    assert!(outcome.server_notified);
    assert_eq!(outcome.cleared_batches, 1);
    assert!(!consent_gate::may_send(&ctx), "đã rút thì không được gửi");
    assert_eq!(pending(&ctx), 0, "hàng đợi phải rỗng");
    let cfg = ctx.load_config().unwrap();
    assert!(local_consent::stored(&cfg).unwrap().is_revoked());
    assert_eq!(
        ctx.credentials.get_token(&server.uri()).unwrap().as_deref(),
        Some(TOKEN),
        "rút đồng ý không phải đăng xuất: token còn nguyên"
    );
    let printed = text(out);
    assert!(printed.contains("1 batch"), "{printed}");
    assert!(printed.contains("Server đã ghi nhận"), "{printed}");
    assert!(printed.contains("`tl consent`"), "{printed}");
}

#[tokio::test]
async fn server_loi_van_rut_o_may_va_canh_bao() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .respond_with(ResponseTemplate::new(500).set_body_string("lỗi máy chủ"))
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server, "v2", false);
    seed_pending_batch(&ctx);

    let mut out = Vec::new();
    let outcome = consent::revoke_with(&ctx, &revoke_args(true), &mut Cursor::new(""), &mut out)
        .await
        .unwrap();
    assert!(!outcome.server_notified);
    assert!(!consent_gate::may_send(&ctx), "máy vẫn phải ngừng gửi");
    assert_eq!(pending(&ctx), 0);
    assert!(text(out).contains("chưa báo được server"));
}

#[tokio::test]
async fn huy_xac_nhan_thi_khong_doi_gi() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server, "v2", false);
    seed_pending_batch(&ctx);

    let mut out = Vec::new();
    let err = consent::revoke_with(
        &ctx,
        &revoke_args(false),
        &mut Cursor::new("khong\n"),
        &mut out,
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("Đã hủy"), "{err}");
    assert!(consent_gate::may_send(&ctx), "chưa rút thì vẫn gửi được");
    assert_eq!(pending(&ctx), 1, "hàng đợi còn nguyên");
}

#[tokio::test]
async fn rut_hai_lan_khong_loi() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(status_body("v2", "revoked", None, None)),
        )
        .expect(2)
        .mount(&server)
        .await;
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    joined(&ctx, &server, "v2", false);

    for _ in 0..2 {
        let outcome = consent::revoke_with(
            &ctx,
            &revoke_args(true),
            &mut Cursor::new(""),
            &mut Vec::new(),
        )
        .await
        .unwrap();
        assert!(outcome.server_notified);
    }
    assert!(!consent_gate::may_send(&ctx));
}

#[tokio::test]
async fn may_chua_tham_gia_thi_khong_co_gi_de_rut() {
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let mut out = Vec::new();
    let outcome = consent::revoke_with(&ctx, &revoke_args(true), &mut Cursor::new(""), &mut out)
        .await
        .unwrap();
    assert!(!outcome.server_notified);
    assert_eq!(outcome.cleared_batches, 0);
    assert!(text(out).contains("không có gì để rút"));
}

#[tokio::test]
async fn khong_co_token_van_rut_o_may() {
    let dir = TempDir::new().unwrap();
    let ctx = test_ctx(&dir);
    let mut config = Config {
        server_url: Some("http://localhost:1".into()),
        ..Default::default()
    };
    local_consent::record(
        &mut config,
        "http://localhost:1",
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

    let mut out = Vec::new();
    let outcome = consent::revoke_with(&ctx, &revoke_args(true), &mut Cursor::new(""), &mut out)
        .await
        .unwrap();
    assert!(!outcome.server_notified);
    assert!(!consent_gate::may_send(&ctx));
    assert!(text(out).contains("chưa có token"));
}
