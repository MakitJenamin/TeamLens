//! Test tích hợp `tl preview` và `tl sync` (task M1.7): fixtures thật của tl-adapters
//! + repo git giả trong thư mục tạm + mock server (wiremock).
//!
//! Bố trí:
//! - `work/shop`: repo `github.com/acme/shop` (trong phạm vi) ← fixture `teamlens-worker`,
//!   có chèn secret giả, output dài và đường dẫn tuyệt đối.
//! - `work/private`: repo `github.com/someone/private-tool` (ngoài phạm vi) ← fixture
//!   `rejected-tool-interrupt`.
//! - `work/nogit`: không phải git repo ← cùng fixture, đổi `sessionId`.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use teamlens::commands::preview::{self, PreviewArgs};
use teamlens::commands::sync::{self, SyncArgs};
use teamlens::config::Config;
use teamlens::consent::{self, ProjectConsent};
use teamlens::context::AppContext;
use teamlens::error::AppError;
use teamlens::pipeline::prepare::PrepareOptions;
use teamlens::sync::Sources;
use tempfile::TempDir;
use tl_adapters::claude_code::ClaudeCodeAdapter;
use tl_platform::{CredentialStore, MemoryCredentialStore};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const TOKEN: &str = "tld_test_token_m17";
const IN_SESSION: &str = "87bb336f-7b98-408c-8812-ae8c0ffca5e8";
const OUT_SESSION: &str = "69d67677-a42c-49fd-85ed-29807f489ff8";
const NOGIT_SESSION: &str = "11111111-2222-4333-8444-555555555555";
const FAKE_AWS: &str = "AKIAIOSFODNN7EXAMPLE";
const FAKE_GH: &str = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
/// Chuỗi chỉ có trong session ngoài phạm vi (đánh dấu thêm vào mọi text của nó).
const OUT_MARKER: &str = "NOI_DUNG_NGOAI_PHAM_VI";

fn fixture(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tl-adapters/tests/fixtures/claude_code")
        .join(rel)
}

fn schema_validator() -> jsonschema::Validator {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/schema/session.v1.schema.json");
    let schema: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    jsonschema::options()
        .should_validate_formats(true)
        .build(&schema)
        .unwrap()
}

fn assert_valid_batch(v: &Value) {
    let validator = schema_validator();
    let errors: Vec<String> = validator
        .iter_errors(v)
        .map(|e| format!("{e} tại {}", e.instance_path()))
        .collect();
    assert!(errors.is_empty(), "batch sai schema: {errors:#?}");
}

/// Đổi mọi chuỗi trong giá trị JSON bằng `f`.
fn map_strings(v: &mut Value, f: &dyn Fn(&str) -> String) {
    match v {
        Value::String(s) => *s = f(s),
        Value::Array(a) => a.iter_mut().for_each(|x| map_strings(x, f)),
        Value::Object(o) => o.values_mut().for_each(|x| map_strings(x, f)),
        _ => {}
    }
}

/// Chép fixture sang `dest` sau khi biến đổi từng dòng JSON.
fn copy_fixture(src: &Path, dest: &Path, mut edit: impl FnMut(usize, &mut Value)) {
    let text = fs::read_to_string(src).unwrap();
    let mut out = String::new();
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let mut v: Value = serde_json::from_str(line).unwrap();
        edit(i, &mut v);
        out.push_str(&serde_json::to_string(&v).unwrap());
        out.push('\n');
    }
    fs::create_dir_all(dest.parent().unwrap()).unwrap();
    fs::write(dest, out).unwrap();
}

fn fake_repo(root: &Path, url: &str) {
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(
        root.join(".git/config"),
        format!("[remote \"origin\"]\n\turl = {url}\n"),
    )
    .unwrap();
    fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
}

struct Env {
    dir: TempDir,
    shop: PathBuf,
    private: PathBuf,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        let shop = work.join("shop");
        let private = work.join("private");
        let nogit = work.join("nogit");
        fake_repo(&shop, "git@github.com:acme/shop.git");
        fake_repo(&private, "https://github.com/someone/private-tool.git");
        fs::create_dir_all(shop.join("cli")).unwrap();
        fs::create_dir_all(&nogit).unwrap();
        fs::write(shop.join("CLAUDE.md"), "# hướng dẫn\n").unwrap();
        fs::write(shop.join("AGENTS.md"), "x".repeat(100)).unwrap();

        let projects = dir.path().join("claude/projects");
        let shop_s = shop.to_string_lossy().to_string();
        let mut long_done = false;
        copy_fixture(
            &fixture("2.1.332/teamlens-worker.jsonl"),
            &projects.join("shop").join(format!("{IN_SESSION}.jsonl")),
            |_, v| {
                // Tool result đầu tiên: output dài có secret và đường dẫn tuyệt đối.
                if !long_done {
                    if let Some(item) = v
                        .pointer_mut("/message/content/0")
                        .filter(|c| c["type"] == "tool_result")
                    {
                        item["content"] = json!(format!(
                            "{shop_s}\\src\\main.rs token={FAKE_GH}\n{}\nhết",
                            "dòng log dài\n".repeat(2_000)
                        ));
                        long_done = true;
                    }
                }
                map_strings(v, &|s| {
                    s.replace(r"C:\Users\dev\orca\workspaces\TeamLens\m1-2", &shop_s)
                        .replace("M1.2", &format!("M1.2 (key {FAKE_AWS})"))
                });
            },
        );
        for (name, sid, cwd) in [
            ("private", OUT_SESSION, private.clone()),
            ("nogit", NOGIT_SESSION, nogit.clone()),
        ] {
            let cwd_s = cwd.to_string_lossy().to_string();
            copy_fixture(
                &fixture("2.1.326/rejected-tool-interrupt.jsonl"),
                &projects.join(name).join(format!("{sid}.jsonl")),
                |_, v| {
                    map_strings(v, &|s| {
                        let s = s
                            .replace(r"C:\Users\dev\Documents\demo-app", &cwd_s)
                            .replace(OUT_SESSION, sid);
                        if s.contains(' ') && !s.contains(&cwd_s) {
                            format!("{s} {OUT_MARKER}")
                        } else {
                            s
                        }
                    });
                },
            );
        }
        Env { dir, shop, private }
    }

    fn sources(&self) -> Sources {
        Sources {
            adapters: vec![Box::new(ClaudeCodeAdapter::new(
                self.dir.path().join("claude"),
            ))],
            prepare: PrepareOptions {
                home_dir: Some(self.dir.path().join("home").to_string_lossy().into()),
                user_name: Some("dev".into()),
                host_name: Some("MAY-TEST".into()),
                limits: Default::default(),
                server_redaction_patterns: Vec::new(),
            },
        }
    }

    /// Context đã tham gia và đồng ý (có backfill) cho project `proj-acme`.
    fn ctx(&self, server: &str) -> AppContext {
        self.ctx_with_consent(server, Some(true))
    }

    /// `backfill = None`: chưa đồng ý gì.
    fn ctx_with_consent(&self, server: &str, backfill: Option<bool>) -> AppContext {
        let config_path = self.dir.path().join("teamlens/config.toml");
        let mut config = Config {
            server_url: Some(server.to_owned()),
            ..Default::default()
        };
        if let Some(backfill) = backfill {
            consent::record(
                &mut config,
                server,
                ProjectConsent {
                    project_id: "proj-acme".into(),
                    project_slug: "acme".into(),
                    project_name: "Acme".into(),
                    text_version: CONSENT_VERSION.into(),
                    backfill,
                    accepted_at: chrono::Utc::now(),
                },
            );
        }
        config.save(&config_path).unwrap();
        let creds = MemoryCredentialStore::new();
        creds.set_token(server, TOKEN).unwrap();
        AppContext {
            config_path,
            credentials: Box::new(creds),
            poll_unit: Duration::from_millis(1),
            open_browser: |_| panic!("test không được mở trình duyệt"),
        }
    }
}

/// Phiên bản văn bản đồng ý mà context test đã đồng ý.
const CONSENT_VERSION: &str = "2026-11-26";

/// Body `GET /agent/v1/config` (snake_case).
fn config_body(consent_text_version: &str, min_cli_version: &str) -> Value {
    json!({
        "repo_patterns": [{ "project_id": "proj-acme", "pattern": "github.com/acme/*" }],
        "redaction_patterns": [{ "id": "acme_internal_token", "regex": "acme_[A-Za-z0-9]{32}" }],
        "truncation": {
            "tool_input_bytes": 4096, "output_head_bytes": 2048, "output_tail_bytes": 1024,
            "diff_bytes": 262144, "thinking_bytes": 8192
        },
        "consent_text_version": consent_text_version,
        "min_cli_version": min_cli_version
    })
}

async fn mock_config_body(server: &MockServer, body: Value) {
    Mock::given(method("GET"))
        .and(path("/agent/v1/config"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(server)
        .await;
}

async fn mock_config(server: &MockServer) {
    mock_config_body(server, config_body(CONSENT_VERSION, "0.1.0")).await;
}

/// Giải nén body ingest, ghi lại, trả lần lượt các phản hồi cho trước rồi 202.
#[derive(Clone)]
struct Ingest {
    bodies: Arc<Mutex<Vec<Value>>>,
    calls: Arc<AtomicUsize>,
    errors: Arc<Vec<ResponseTemplate>>,
}

impl Ingest {
    fn new(errors: Vec<ResponseTemplate>) -> Self {
        Self {
            bodies: Arc::default(),
            calls: Arc::default(),
            errors: Arc::new(errors),
        }
    }
}

impl Respond for Ingest {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        assert_eq!(
            req.headers
                .get("content-encoding")
                .unwrap()
                .to_str()
                .unwrap(),
            "gzip"
        );
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(r) = self.errors.get(n) {
            return r.clone();
        }
        let mut text = String::new();
        flate2::read::GzDecoder::new(&req.body[..])
            .read_to_string(&mut text)
            .unwrap();
        let body: Value = serde_json::from_str(&text).unwrap();
        let accepted: Vec<Value> = body["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                json!({
                    "sourceId": s["session"]["source_id"],
                    "sessionId": "3f1e2d4c-5b6a-4789-8a0b-1c2d3e4f5a6b",
                    "turnsUpserted": s["turns"].as_array().unwrap().len()
                })
            })
            .collect();
        let result = json!({
            "batchId": body["batch_id"], "duplicate": false,
            "accepted": accepted, "rejected": []
        });
        self.bodies.lock().unwrap().push(body);
        ResponseTemplate::new(202).set_body_json(result)
    }
}

async fn server_with(ingest: Ingest) -> MockServer {
    let server = MockServer::start().await;
    mock_config(&server).await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/ingest"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ingest)
        .mount(&server)
        .await;
    server
}

/// Kiểm tra payload không lộ gì: không session ngoài phạm vi, không secret, không đường dẫn tuyệt đối.
fn assert_clean(env: &Env, text: &str) {
    for needle in [
        OUT_SESSION,
        NOGIT_SESSION,
        OUT_MARKER,
        FAKE_AWS,
        FAKE_GH,
        r"C:\\Users",
        "C:/Users",
        r"Users\\dev",
    ] {
        assert!(!text.contains(needle), "payload còn \"{needle}\"");
    }
    for p in [&env.shop, &env.private, &env.dir.path().to_path_buf()] {
        let s = p.to_string_lossy();
        let escaped = serde_json::to_string(&s).unwrap();
        assert!(
            !text.contains(escaped.trim_matches('"')) && !text.contains(s.as_ref()),
            "payload còn đường dẫn tuyệt đối {s}"
        );
    }
}

async fn run_preview(
    env: &Env,
    ctx: &AppContext,
    arg: Option<String>,
) -> (Result<(), AppError>, String) {
    let mut out = Vec::new();
    let mut note = Vec::new();
    let r = preview::run_with(
        ctx,
        PreviewArgs { session: arg },
        &env.sources(),
        &mut out,
        &mut note,
    )
    .await;
    (r, String::from_utf8(out).unwrap())
}

#[tokio::test]
async fn preview_session_gan_nhat_trong_pham_vi() {
    let env = Env::new();
    let server = server_with(Ingest::new(vec![])).await;
    let ctx = env.ctx(&server.uri());
    let (r, out) = run_preview(&env, &ctx, None).await;
    r.unwrap();

    let batch: Value = serde_json::from_str(&out).expect("preview phải in JSON");
    assert_valid_batch(&batch);
    assert_clean(&env, &out);
    let sessions = batch["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    let s = &sessions[0]["session"];
    assert_eq!(s["source_id"], format!("claude_code:{IN_SESSION}"));
    assert_eq!(s["repo_remote"], "github.com/acme/shop");
    assert_eq!(s["cwd_relative"], "");
    assert_eq!(
        s["instruction_files"],
        json!([{ "path": "CLAUDE.md", "bytes": 17 }, { "path": "AGENTS.md", "bytes": 100 }])
    );

    // Secret giả đã che và ghi `redactions`.
    assert!(out.contains("[REDACTED:aws_access_key]"));
    assert!(out.contains("[REDACTED:github_token]"));
    let turns = sessions[0]["turns"].as_array().unwrap();
    assert!(turns.iter().any(|t| t["redactions"]
        .as_array()
        .is_some_and(|r| r.iter().any(|x| x["type"] == "aws_access_key"))));

    // Output dài bị cắt, đường dẫn trong output thành tương đối.
    let long = turns
        .iter()
        .find_map(|t| t.get("output").filter(|o| o["truncated"] == true))
        .expect("phải có output bị cắt");
    assert!(long["original_bytes"].as_u64().unwrap() > 20_000);
    assert!(long["text"].as_str().unwrap().len() < 4_000);
    assert!(long["text"].as_str().unwrap().starts_with("src/main.rs"));

    // Không gọi ingest.
    let ingest_calls = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.url.path() == "/agent/v1/ingest")
        .count();
    assert_eq!(ingest_calls, 0);
}

#[tokio::test]
async fn preview_file_ngoai_pham_vi_khong_in_noi_dung() {
    let env = Env::new();
    let server = server_with(Ingest::new(vec![])).await;
    let ctx = env.ctx(&server.uri());
    for arg in [
        env.dir
            .path()
            .join(format!("claude/projects/private/{OUT_SESSION}.jsonl"))
            .to_string_lossy()
            .to_string(),
        format!("claude_code:{NOGIT_SESSION}"),
    ] {
        let (r, out) = run_preview(&env, &ctx, Some(arg)).await;
        r.unwrap();
        assert!(out.contains("ngoài phạm vi"), "{out}");
        assert!(!out.contains('{'), "không được in JSON: {out}");
        assert_clean(&env, &out);
    }
    // source_id trong phạm vi (chỉ uuid) vẫn xem được.
    let (r, out) = run_preview(&env, &ctx, Some(IN_SESSION.to_owned())).await;
    r.unwrap();
    assert!(out.contains(IN_SESSION));
    let (r, _) = run_preview(&env, &ctx, Some("khong-co".to_owned())).await;
    assert!(r.is_err());
}

/// Test cũ (M1.7) ghi fixture ngay trước khi chạy nên luôn kèm `--include-active`.
async fn run_sync(
    env: &Env,
    ctx: &AppContext,
    dry_run: bool,
    max: usize,
) -> (Result<(), AppError>, String) {
    run_sync_with(env, ctx, dry_run, true, max).await
}

async fn run_sync_with(
    env: &Env,
    ctx: &AppContext,
    dry_run: bool,
    include_active: bool,
    max: usize,
) -> (Result<(), AppError>, String) {
    let mut out = Vec::new();
    let r = sync::run_with(
        ctx,
        SyncArgs {
            once: true,
            dry_run,
            include_active,
        },
        &env.sources(),
        max,
        &mut out,
    )
    .await;
    (r, String::from_utf8(out).unwrap())
}

#[tokio::test]
async fn sync_gui_batch_hop_le_chi_session_trong_pham_vi() {
    let env = Env::new();
    let ingest = Ingest::new(vec![]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let (r, out) = run_sync(&env, &ctx, false, 8 << 20).await;
    r.unwrap();

    assert!(out.contains("1 session trong phạm vi"), "{out}");
    assert!(out.contains("2 session ngoài phạm vi bị bỏ"), "{out}");
    assert!(out.contains("server nhận 1 session"), "{out}");
    assert!(out.contains(&format!(
        "{}/projects/proj-acme/sessions/3f1e2d4c-5b6a-4789-8a0b-1c2d3e4f5a6b",
        server.uri()
    )));

    let bodies = ingest.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 1);
    assert_valid_batch(&bodies[0]);
    let text = serde_json::to_string(&bodies[0]).unwrap();
    assert_clean(&env, &text);
    assert_eq!(bodies[0]["sessions"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn sync_dry_run_khong_gui() {
    let env = Env::new();
    let ingest = Ingest::new(vec![]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let (r, out) = run_sync(&env, &ctx, true, 8 << 20).await;
    r.unwrap();
    assert!(out.contains("--dry-run"), "{out}");
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn sync_413_chia_nho_roi_gui_lai() {
    let env = Env::new();
    let ingest = Ingest::new(vec![ResponseTemplate::new(413).set_body_json(
        json!({ "error": "payload_too_large", "message": "Batch vượt quá 10 MB" }),
    )]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let (r, out) = run_sync(&env, &ctx, false, 8 << 20).await;
    r.unwrap();
    assert_eq!(
        ingest.calls.load(Ordering::SeqCst),
        3,
        "1 lần 413 + 2 nửa: {out}"
    );
    let bodies = ingest.bodies.lock().unwrap();
    let mut seqs: Vec<u64> = bodies
        .iter()
        .flat_map(|b| {
            assert_valid_batch(b);
            b["sessions"][0]["turns"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["seq"].as_u64().unwrap())
                .collect::<Vec<_>>()
        })
        .collect();
    let n = seqs.len() as u64;
    seqs.sort_unstable();
    assert_eq!(seqs, (0..n).collect::<Vec<_>>(), "đủ turn, không trùng");
    assert!(out.contains("Đã gửi 2 batch"), "{out}");
}

#[tokio::test]
async fn sync_chia_batch_theo_kich_thuoc() {
    let env = Env::new();
    let ingest = Ingest::new(vec![]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let (r, _) = run_sync(&env, &ctx, false, 5_000).await;
    r.unwrap();
    let bodies = ingest.bodies.lock().unwrap();
    assert!(bodies.len() > 1);
    for b in bodies.iter() {
        assert_valid_batch(b);
        assert!(
            serde_json::to_vec(b).unwrap().len() <= 20_000
                || b["sessions"][0]["turns"].as_array().unwrap().len() == 1
        );
    }
}

#[tokio::test]
async fn sync_429_cho_roi_thu_lai_mot_lan() {
    let env = Env::new();
    let limited = ResponseTemplate::new(429)
        .insert_header("Retry-After", "2")
        .set_body_json(json!({ "error": "rate_limited", "message": "Gửi quá nhanh" }));
    let ingest = Ingest::new(vec![limited.clone()]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let (r, _) = run_sync(&env, &ctx, false, 8 << 20).await;
    r.unwrap();
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 2);

    // 429 hai lần liên tiếp: dừng, báo lỗi.
    let ingest = Ingest::new(vec![limited.clone(), limited]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let (r, _) = run_sync(&env, &ctx, false, 8 << 20).await;
    let e = r.unwrap_err();
    assert!(e.to_string().contains("quá nhanh"), "{e}");
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn sync_426_bao_cap_nhat() {
    let env = Env::new();
    let ingest = Ingest::new(vec![ResponseTemplate::new(426).set_body_json(json!({
        "error": "unsupported_schema_version",
        "message": "Phiên bản dữ liệu 1 không được hỗ trợ.",
        "supportedSchemaVersions": [2],
        "minCliVersion": "0.9.0"
    }))]);
    let server = server_with(ingest).await;
    let ctx = env.ctx(&server.uri());
    let (r, _) = run_sync(&env, &ctx, false, 8 << 20).await;
    let e = r.unwrap_err();
    assert_eq!(e.exit_code(), 1);
    assert!(e.hint().unwrap().contains("0.9.0"), "{:?}", e.hint());
    assert!(e.hint().unwrap().contains("tl update"), "{:?}", e.hint());
}

#[tokio::test]
async fn sync_401_nhac_dang_nhap() {
    let env = Env::new();
    let ingest = Ingest::new(vec![ResponseTemplate::new(401).set_body_json(
        json!({ "error": "invalid_token", "message": "Token không hợp lệ" }),
    )]);
    let server = server_with(ingest).await;
    let ctx = env.ctx(&server.uri());
    let (r, _) = run_sync(&env, &ctx, false, 8 << 20).await;
    let e = r.unwrap_err();
    assert!(e.hint().unwrap().contains("tl join"));

    // config 401 cũng vậy.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/config"))
        .respond_with(
            ResponseTemplate::new(401).set_body_json(
                json!({ "error": "invalid_token", "message": "Token không hợp lệ" }),
            ),
        )
        .mount(&server)
        .await;
    let ctx = env.ctx(&server.uri());
    let (r, _) = run_sync(&env, &ctx, false, 8 << 20).await;
    assert!(r.unwrap_err().hint().unwrap().contains("tl join"));
}

#[tokio::test]
async fn sync_loi_mang_exit_khac_0() {
    let env = Env::new();
    // Cổng đóng: lấy địa chỉ của server rồi tắt nó.
    let uri = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let ctx = env.ctx(&uri);
    let (r, _) = run_sync(&env, &ctx, false, 8 << 20).await;
    let e = r.unwrap_err();
    assert_ne!(e.exit_code(), 0);
    assert!(e.to_string().contains("Không kết nối được"), "{e}");
}

#[tokio::test]
async fn chua_dang_nhap_bao_loi_ro() {
    let env = Env::new();
    let ctx = env.ctx("http://127.0.0.1:9");
    ctx.credentials.delete_token("http://127.0.0.1:9").unwrap();
    let (r, _) = run_sync(&env, &ctx, false, 8 << 20).await;
    assert!(r.unwrap_err().hint().unwrap().contains("tl join"));
}

#[tokio::test]
async fn sync_chua_dong_y_khong_goi_server() {
    let env = Env::new();
    // Không có mock nào: gọi server là lỗi kết nối, nên lỗi phải đến trước đó.
    let ctx = env.ctx_with_consent("http://127.0.0.1:9", None);
    let (r, _) = run_sync(&env, &ctx, false, 8 << 20).await;
    let e = r.unwrap_err();
    assert!(e.to_string().contains("chưa đồng ý"), "{e}");
    assert!(e.hint().unwrap().contains("tl join"));
}

#[tokio::test]
async fn sync_dry_run_chua_dong_y_van_xem_duoc() {
    let env = Env::new();
    let ingest = Ingest::new(vec![]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx_with_consent(&server.uri(), None);
    let (r, text) = run_sync(&env, &ctx, true, 8 << 20).await;
    r.unwrap();
    assert!(text.contains("chưa đồng ý"), "{text}");
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn sync_khong_backfill_bo_session_cu() {
    let env = Env::new();
    let ingest = Ingest::new(vec![]);
    let server = server_with(ingest.clone()).await;
    // Đồng ý lúc này, không backfill: session trong fixture đều cũ hơn.
    let ctx = env.ctx_with_consent(&server.uri(), Some(false));
    let (r, text) = run_sync(&env, &ctx, false, 8 << 20).await;
    r.unwrap();
    assert!(text.contains("Bỏ 1 session"), "{text}");
    assert!(text.contains("Không có session nào"), "{text}");
    assert_eq!(
        ingest.calls.load(Ordering::SeqCst),
        0,
        "không được gửi session cũ"
    );
}

/// Server chỉ có `GET /agent/v1/config` với body cho trước và ingest ghi lại.
async fn server_with_config(ingest: Ingest, body: Value) -> MockServer {
    let server = MockServer::start().await;
    mock_config_body(&server, body).await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/ingest"))
        .respond_with(ingest)
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn sync_lech_phien_ban_dong_y_khong_gui() {
    let env = Env::new();
    let ingest = Ingest::new(vec![]);
    let server = server_with_config(ingest.clone(), config_body("2026-12-01", "0.1.0")).await;
    let ctx = env.ctx(&server.uri());
    let (r, _) = run_sync(&env, &ctx, false, 8 << 20).await;
    let e = r.unwrap_err();
    assert_ne!(e.exit_code(), 0);
    assert!(e.to_string().contains("2026-12-01"), "{e}");
    assert!(e.to_string().contains(CONSENT_VERSION), "{e}");
    assert!(e.hint().unwrap().contains("tl consent"), "{:?}", e.hint());
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 0, "không được gửi gì");

    // --dry-run vẫn xem được, kèm lưu ý.
    let (r, out) = run_sync(&env, &ctx, true, 8 << 20).await;
    r.unwrap();
    assert!(out.contains("Văn bản đồng ý"), "{out}");
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn sync_cli_cu_hon_min_version_khong_gui() {
    let env = Env::new();
    let ingest = Ingest::new(vec![]);
    let server = server_with_config(ingest.clone(), config_body(CONSENT_VERSION, "9.9.9")).await;
    let ctx = env.ctx(&server.uri());
    let (r, _) = run_sync(&env, &ctx, false, 8 << 20).await;
    let e = r.unwrap_err();
    assert_ne!(e.exit_code(), 0);
    assert!(e.to_string().contains("9.9.9"), "{e}");
    assert!(e.hint().unwrap().contains("tl update"), "{:?}", e.hint());
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 0, "không được gửi gì");
}

#[tokio::test]
async fn sync_ap_nguong_cat_tu_config() {
    let env = Env::new();
    let ingest = Ingest::new(vec![]);
    let mut body = config_body(CONSENT_VERSION, "0.1.0");
    body["truncation"]["output_head_bytes"] = json!(100);
    body["truncation"]["output_tail_bytes"] = json!(50);
    let server = server_with_config(ingest.clone(), body).await;
    let ctx = env.ctx(&server.uri());
    let (r, _) = run_sync(&env, &ctx, false, 8 << 20).await;
    r.unwrap();
    let bodies = ingest.bodies.lock().unwrap();
    let turns = bodies[0]["sessions"][0]["turns"].as_array().unwrap();
    let long = turns
        .iter()
        .find_map(|t| t.get("output").filter(|o| o["truncated"] == true))
        .expect("phải có output bị cắt");
    assert!(
        long["text"].as_str().unwrap().len() < 300,
        "ngưỡng 100 + 50 byte từ config"
    );
}

// ---------------------------------------------------------------------------
// M2.3: đọc tăng dần theo `state.db`, chờ file ổn định 2 phút.
// ---------------------------------------------------------------------------

fn in_file(env: &Env) -> PathBuf {
    env.dir
        .path()
        .join("claude")
        .join("projects")
        .join("shop")
        .join(format!("{IN_SESSION}.jsonl"))
}

/// Đặt mtime mọi file log về 10 phút trước (giả lập file đã ổn định).
fn age_logs(env: &Env) {
    let old = std::time::SystemTime::now() - Duration::from_secs(600);
    for dir in ["shop", "private", "nogit"] {
        let d = env.dir.path().join("claude/projects").join(dir);
        for e in fs::read_dir(d).unwrap().flatten() {
            fs::File::options()
                .write(true)
                .open(e.path())
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
    }
}

/// Seq các turn của session trong phạm vi trong các body từ vị trí `from`.
fn sent_turns(ingest: &Ingest, from: usize) -> Vec<Value> {
    ingest.bodies.lock().unwrap()[from..]
        .iter()
        .flat_map(|b| {
            b["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|s| s["turns"].as_array().unwrap().clone())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn seqs(turns: &[Value]) -> Vec<u64> {
    let mut v: Vec<u64> = turns.iter().map(|t| t["seq"].as_u64().unwrap()).collect();
    v.sort_unstable();
    v
}

#[tokio::test]
async fn tang_dan_chi_gui_phan_moi_va_khong_gui_lai_khi_khong_doi() {
    let env = Env::new();
    let full = fs::read_to_string(in_file(&env)).unwrap();
    let lines: Vec<&str> = full.lines().collect();
    let half = lines.len() / 2;
    fs::write(in_file(&env), format!("{}\n", lines[..half].join("\n"))).unwrap();
    age_logs(&env);

    let ingest = Ingest::new(vec![]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());

    // Lần 1: gửi đủ nửa đầu.
    let (r, out) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    let first = sent_turns(&ingest, 0);
    let n1 = first.len() as u64;
    assert!(n1 > 2, "{out}");
    assert_eq!(seqs(&first), (0..n1).collect::<Vec<_>>());
    let bodies1 = ingest.bodies.lock().unwrap().len();
    // File ổn định → `ended_at` đã chốt.
    assert!(!ingest.bodies.lock().unwrap()[0]["sessions"][0]["session"]["ended_at"].is_null());

    // Lần 2: không đổi → không gọi ingest.
    let calls = ingest.calls.load(Ordering::SeqCst);
    let (r, out) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    assert_eq!(ingest.calls.load(Ordering::SeqCst), calls, "{out}");
    assert!(out.contains("Bỏ qua 3 file log không đổi"), "{out}");

    // Lần 3: thêm nửa sau → chỉ gửi turn mới (cộng vài turn cuối có thể còn đổi).
    fs::write(in_file(&env), format!("{}\n", lines.join("\n"))).unwrap();
    age_logs(&env);
    let (r, out) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    let second = sent_turns(&ingest, bodies1);
    let s2 = seqs(&second);
    assert!(
        s2[0] > 0 && s2[0] < n1,
        "gửi lại ít nhất turn cuối, không từ đầu: {s2:?}"
    );
    let total = *s2.last().unwrap() + 1;
    assert!(total > n1, "{out}");
    assert_eq!(s2, (s2[0]..total).collect::<Vec<_>>());

    // Ghép như server (upsert theo seq) phải ra đúng bản gửi cả file từ đầu.
    let mut merged: std::collections::BTreeMap<u64, Value> = Default::default();
    for t in first.into_iter().chain(second) {
        merged.insert(t["seq"].as_u64().unwrap(), t);
    }
    let ingest_b = Ingest::new(vec![]);
    let server_b = server_with(ingest_b.clone()).await;
    let ctx_b = env.ctx(&server_b.uri()); // server khác → quên offset, gửi từ đầu.
    let (r, _) = run_sync_with(&env, &ctx_b, false, false, 8 << 20).await;
    r.unwrap();
    let whole = sent_turns(&ingest_b, 0);
    assert_eq!(whole.len() as u64, total);
    for t in whole {
        assert_eq!(
            merged[&t["seq"].as_u64().unwrap()],
            t,
            "turn khác bản đọc cả file"
        );
    }
}

#[tokio::test]
async fn tang_dan_file_ngan_lai_gui_lai_tu_dau() {
    let env = Env::new();
    age_logs(&env);
    let ingest = Ingest::new(vec![]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let (r, _) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    let before = ingest.bodies.lock().unwrap().len();

    let full = fs::read_to_string(in_file(&env)).unwrap();
    let lines: Vec<&str> = full.lines().collect();
    fs::write(
        in_file(&env),
        format!("{}\n", lines[..lines.len() / 3].join("\n")),
    )
    .unwrap();
    age_logs(&env);
    let (r, out) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    let again = seqs(&sent_turns(&ingest, before));
    assert_eq!(again.first(), Some(&0), "{out}");
    assert_eq!(again, (0..again.len() as u64).collect::<Vec<_>>());
}

#[tokio::test]
async fn tang_dan_gui_loi_khong_tien_offset() {
    let env = Env::new();
    age_logs(&env);
    let ingest =
        Ingest::new(vec![ResponseTemplate::new(500)
            .set_body_json(json!({ "error": "internal", "message": "lỗi" }))]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let (r, _) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    assert!(r.is_err());
    assert_eq!(ingest.bodies.lock().unwrap().len(), 0);

    // Lần sau gửi lại đủ từ đầu, rồi lần sau nữa không gửi gì.
    let (r, out) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    let turns = seqs(&sent_turns(&ingest, 0));
    assert_eq!(turns.first(), Some(&0), "{out}");
    assert_eq!(turns, (0..turns.len() as u64).collect::<Vec<_>>());
    let calls = ingest.calls.load(Ordering::SeqCst);
    let (r, _) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    assert_eq!(ingest.calls.load(Ordering::SeqCst), calls);
}

#[tokio::test]
async fn tang_dan_file_moi_sua_chua_gui_tru_khi_include_active() {
    let env = Env::new(); // file vừa ghi: chưa ổn định
    let ingest = Ingest::new(vec![]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let (r, out) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 0, "{out}");
    assert!(out.contains("3 file log đang được ghi"), "{out}");
    assert!(out.contains("--include-active"), "{out}");

    let (r, out) = run_sync_with(&env, &ctx, false, true, 8 << 20).await;
    r.unwrap();
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 1, "{out}");
    // Đang ghi → `ended_at` còn trống.
    assert!(ingest.bodies.lock().unwrap()[0]["sessions"][0]["session"]["ended_at"].is_null());

    // Khi file ổn định (ở đây: mtime cũ đi) thì gửi lại để chốt `ended_at`.
    age_logs(&env);
    let (r, _) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    let bodies = ingest.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2);
    assert!(!bodies[1]["sessions"][0]["session"]["ended_at"].is_null());
    assert!(
        bodies[1]["sessions"][0]["turns"].as_array().unwrap().len()
            < bodies[0]["sessions"][0]["turns"].as_array().unwrap().len()
    );
}

#[tokio::test]
async fn mat_mang_dung_config_cache() {
    let env = Env::new();
    // Lần 1: server sống, config được cache.
    let server = server_with(Ingest::new(vec![])).await;
    let uri = server.uri();
    let ctx = env.ctx(&uri);
    let (r, _) = run_preview(&env, &ctx, None).await;
    r.unwrap();
    let cache = ctx.config_path.parent().unwrap().join("agent_config.json");
    assert!(cache.is_file(), "phải ghi cache");
    // Lần 2: server ở địa chỉ khác đã tắt (wiremock giữ server trong pool nên không tắt
    // được server cũ); chép cache sang địa chỉ đó → preview vẫn chạy bằng cache.
    let dead = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let ctx = env.ctx(&dead);
    let mut cached: Value = serde_json::from_str(&fs::read_to_string(&cache).unwrap()).unwrap();
    assert_eq!(cached["server_url"], uri.as_str());
    cached["server_url"] = json!(dead);
    fs::write(&cache, serde_json::to_string(&cached).unwrap()).unwrap();

    let mut out = Vec::new();
    let mut note = Vec::new();
    let r = preview::run_with(
        &ctx,
        PreviewArgs { session: None },
        &env.sources(),
        &mut out,
        &mut note,
    )
    .await;
    r.unwrap();
    let note = String::from_utf8(note).unwrap();
    assert!(note.contains("dùng bản đã lưu"), "{note}");
    let batch: Value = serde_json::from_slice(&out).expect("preview vẫn in JSON");
    assert_eq!(batch["sessions"].as_array().unwrap().len(), 1);

    // Server trả 5xx (proxy báo API tắt) → cũng dùng cache.
    let down = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/config"))
        .respond_with(ResponseTemplate::new(502))
        .mount(&down)
        .await;
    let ctx_down = env.ctx(&down.uri());
    cached["server_url"] = json!(down.uri());
    fs::write(&cache, serde_json::to_string(&cached).unwrap()).unwrap();
    let mut note = Vec::new();
    preview::run_with(
        &ctx_down,
        PreviewArgs { session: None },
        &env.sources(),
        &mut Vec::new(),
        &mut note,
    )
    .await
    .unwrap();
    assert!(String::from_utf8(note).unwrap().contains("dùng bản đã lưu"));

    // Không có cache → lỗi kết nối như cũ (`env.ctx` ghi lại config.toml trỏ về `dead`).
    let ctx = env.ctx(&dead);
    std::fs::remove_file(&cache).unwrap();
    let (r, _) = run_preview(&env, &ctx, None).await;
    assert!(r.unwrap_err().to_string().contains("Không kết nối được"));
}

#[tokio::test]
async fn status_dem_file_cho_on_dinh() {
    use teamlens::commands::status::waiting_files;
    let env = Env::new();
    let ctx = env.ctx("http://127.0.0.1:9");
    assert_eq!(waiting_files(&ctx, &env.sources()), Some(3));
    age_logs(&env);
    assert_eq!(waiting_files(&ctx, &env.sources()), Some(0));
}

// ---- M3.1: hàng đợi trong state.db ----

use std::time::SystemTime;
use teamlens::api_client::{AgentConfig, ApiClient};
use teamlens::queue::{self, FlushOptions, FlushStop};
use teamlens::state::{state_path, StateDb};
use teamlens::sync::agent_config;

fn open_state(ctx: &AppContext) -> StateDb {
    StateDb::open(&state_path(&ctx.config_path)).unwrap()
}

fn server_config() -> AgentConfig {
    serde_json::from_value(config_body(CONSENT_VERSION, "0.1.0")).unwrap()
}

/// Một địa chỉ hiện không có server nào nghe ("API đang tắt").
fn dead_addr() -> std::net::SocketAddr {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap()
}

/// Bật server (config + ingest) đúng địa chỉ đã dùng lúc "tắt".
async fn start_at(addr: std::net::SocketAddr, ingest: Ingest) -> MockServer {
    let listener = std::net::TcpListener::bind(addr).unwrap();
    let server = MockServer::builder().listener(listener).start().await;
    mock_config(&server).await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/ingest"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ingest)
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn hang_doi_tat_api_roi_bat_lai_khong_mat_khong_trung() {
    let env = Env::new();
    age_logs(&env);
    let addr = dead_addr();
    let uri = format!("http://{addr}");
    let ctx = env.ctx(&uri);
    // Config đã cache từ lần chạy trước (API tắt thì dùng cache).
    agent_config::write_cache(&agent_config::cache_path(&ctx), &uri, &server_config());

    // API tắt: batch vào hàng đợi, offset không tiến, lệnh báo lỗi.
    let (r, out) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    let e = r.unwrap_err();
    assert!(e.to_string().contains("Không kết nối được"), "{e}");
    assert!(out.contains("hàng đợi giữ 1 batch"), "{out}");
    let db = open_state(&ctx);
    let pending = queue::list_pending(&db).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].attempts, 1);
    assert!(pending[0].last_error.is_some());
    let batch_id = pending[0].batch_id.clone();
    assert_eq!(
        db.file(&in_file(&env)).unwrap(),
        None,
        "offset chưa được chốt"
    );
    drop(db);

    // Quét lại khi vẫn tắt: không xếp hàng trùng.
    let (r, out) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    assert!(r.is_err());
    assert!(out.contains("Bỏ qua 3 file log không đổi"), "{out}");
    assert!(out.contains("hàng đợi giữ 1 batch"), "{out}");
    let db = open_state(&ctx);
    assert_eq!(queue::list_pending(&db).unwrap().len(), 1);
    drop(db);

    // Bật API: gửi đúng batch cũ (giữ `batch_id`), đủ turn, không trùng.
    let ingest = Ingest::new(vec![]);
    let _server = start_at(addr, ingest.clone()).await;
    let (r, out) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    assert!(out.contains("Đã gửi 1 batch"), "{out}");
    {
        let bodies = ingest.bodies.lock().unwrap();
        assert_eq!(bodies.len(), 1);
        assert_eq!(bodies[0]["batch_id"], batch_id.as_str());
        assert_valid_batch(&bodies[0]);
    }
    let turns = seqs(&sent_turns(&ingest, 0));
    assert_eq!(turns, (0..turns.len() as u64).collect::<Vec<_>>());
    let db = open_state(&ctx);
    assert_eq!(queue::queue_stats(&db).unwrap().pending_batches, 0);
    let saved = db.file(&in_file(&env)).unwrap().expect("đã chốt offset");
    assert_eq!(saved.sessions[0].sent_turns as usize, turns.len());
    drop(db);

    // Lần sau không gửi gì.
    let (r, _) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn hang_doi_5xx_thu_lai_theo_backoff() {
    let env = Env::new();
    age_logs(&env);
    let err500 =
        ResponseTemplate::new(500).set_body_json(json!({ "error": "internal", "message": "lỗi" }));
    let ingest = Ingest::new(vec![err500.clone(), err500]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let (r, _) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    assert!(r.is_err());

    let client = ApiClient::new(&server.uri(), Some(TOKEN.into())).unwrap();
    let config = server_config();
    let mut db = open_state(&ctx);
    let first = queue::list_pending(&db).unwrap().remove(0);
    let next = first.next_attempt_at.unwrap();
    let now = SystemTime::now();
    let wait = (next - chrono::Utc::now()).num_seconds();
    assert!((10..=31).contains(&wait), "lần 1 chờ 15–30 s: {wait}");

    // Daemon chưa tới giờ: không gửi.
    let rep = queue::flush(
        &ctx,
        &mut db,
        &client,
        &config,
        &FlushOptions::background(now),
    )
    .await
    .unwrap();
    assert!(matches!(rep.stop, Some(FlushStop::Waiting { .. })));
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 1);

    // Tới giờ: 500 lần nữa → số lần thử 2, chờ lâu hơn.
    let later = now + Duration::from_secs(31);
    let rep = queue::flush(
        &ctx,
        &mut db,
        &client,
        &config,
        &FlushOptions::background(later),
    )
    .await
    .unwrap();
    assert!(matches!(rep.stop, Some(FlushStop::Retry { .. })));
    let second = queue::list_pending(&db).unwrap().remove(0);
    assert_eq!(second.attempts, 2);
    assert_eq!(second.batch_id, first.batch_id);
    let gap = (second.next_attempt_at.unwrap() - chrono::DateTime::<chrono::Utc>::from(later))
        .num_seconds();
    assert!((29..=61).contains(&gap), "lần 2 chờ 30–60 s: {gap}");

    // Lần 3 thành công, cùng `batch_id`.
    let rep = queue::flush(
        &ctx,
        &mut db,
        &client,
        &config,
        &FlushOptions::background(later + Duration::from_secs(61)),
    )
    .await
    .unwrap();
    assert!(rep.stop.is_none());
    assert_eq!(rep.sent_batches, 1);
    assert_eq!(
        ingest.bodies.lock().unwrap()[0]["batch_id"],
        first.batch_id.as_str()
    );
    assert!(db.file(&in_file(&env)).unwrap().is_some());
}

#[tokio::test]
async fn hang_doi_400_danh_dau_hong_khong_thu_lai() {
    let env = Env::new();
    age_logs(&env);
    let ingest = Ingest::new(vec![ResponseTemplate::new(400).set_body_json(
        json!({ "error": "invalid_body", "message": "Batch sai schema" }),
    )]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let (r, out) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    assert!(out.contains("bị server từ chối, không gửi lại"), "{out}");
    let db = open_state(&ctx);
    let stats = queue::queue_stats(&db).unwrap();
    assert_eq!((stats.pending_batches, stats.failed_batches), (0, 1));
    drop(db);
    // Không thử lại mãi: lần sau không gửi gì.
    let (r, _) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn hang_doi_426_giu_nguyen_roi_gui_sau() {
    let env = Env::new();
    age_logs(&env);
    let ingest = Ingest::new(vec![ResponseTemplate::new(426).set_body_json(json!({
        "error": "unsupported_schema_version",
        "message": "Phiên bản dữ liệu 1 không được hỗ trợ.",
        "supportedSchemaVersions": [2],
        "minCliVersion": "0.9.0"
    }))]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let (r, out) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    assert!(r.unwrap_err().hint().unwrap().contains("0.9.0"));
    assert!(out.contains("hàng đợi giữ 1 batch"), "{out}");
    let db = open_state(&ctx);
    let pending = queue::list_pending(&db).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(db.file(&in_file(&env)).unwrap(), None);
    drop(db);
    // Server nhận lại (vd. sau khi cập nhật): gửi đúng batch cũ.
    let (r, _) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    r.unwrap();
    assert_eq!(
        ingest.bodies.lock().unwrap()[0]["batch_id"],
        pending[0].batch_id.as_str()
    );
}

#[tokio::test]
async fn hang_doi_chua_dong_y_thi_khong_gui_va_giu_hang_doi() {
    let env = Env::new();
    age_logs(&env);
    let ingest = Ingest::new(vec![ResponseTemplate::new(503)]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let (r, _) = run_sync_with(&env, &ctx, false, false, 8 << 20).await;
    assert!(r.is_err());
    // Rút đồng ý (config không còn bản đồng ý cho server này).
    let no_consent = env.ctx_with_consent(&server.uri(), None);
    let client = ApiClient::new(&server.uri(), Some(TOKEN.into())).unwrap();
    let mut db = open_state(&no_consent);
    let opts = FlushOptions {
        now: SystemTime::now(),
        ignore_backoff: true,
        rate_limit_wait: None,
    };
    let rep = queue::flush(&no_consent, &mut db, &client, &server_config(), &opts)
        .await
        .unwrap();
    assert!(matches!(rep.stop, Some(FlushStop::Blocked(_))));
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 1, "không gửi thêm");
    assert_eq!(
        queue::list_pending(&db).unwrap().len(),
        1,
        "không xóa hàng đợi"
    );
}

// ---- M3.3: tạm dừng và heartbeat cuối `tl sync` ----

/// Mock `POST /agent/v1/heartbeat`, ghi lại body.
async fn mock_heartbeat(server: &MockServer) -> Arc<Mutex<Vec<Value>>> {
    let bodies: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen = bodies.clone();
    Mock::given(method("POST"))
        .and(path("/agent/v1/heartbeat"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(move |req: &Request| {
            seen.lock()
                .unwrap()
                .push(serde_json::from_slice::<Value>(&req.body).unwrap());
            ResponseTemplate::new(200).set_body_json(json!({
                "status": "online", "consent_text_version": CONSENT_VERSION,
                "min_cli_version": "0.1.0"
            }))
        })
        .mount(server)
        .await;
    bodies
}

fn state_db(ctx: &AppContext) -> teamlens::state::StateDb {
    teamlens::state::StateDb::open(&teamlens::state::state_path(&ctx.config_path)).unwrap()
}

#[tokio::test]
async fn sync_gui_heartbeat_cuoi_luot() {
    let env = Env::new();
    let ingest = Ingest::new(vec![]);
    let server = server_with(ingest.clone()).await;
    let beats = mock_heartbeat(&server).await;
    let ctx = env.ctx(&server.uri());
    let (r, out) = run_sync(&env, &ctx, false, 8 << 20).await;
    r.unwrap();
    assert!(out.contains("server nhận 1 session"), "{out}");
    let beats = beats.lock().unwrap();
    assert_eq!(beats.len(), 1);
    let b = &beats[0];
    assert_eq!(b["status"], "online");
    assert_eq!(b["agents"][0]["agent"], "claude_code");
    assert_eq!(b["agents"][0]["files"], 3);
    // Phiên bản lấy từ session trong phạm vi (fixture 2.1.332).
    assert_eq!(b["agents"][0]["version"], "2.1.332");
    assert_eq!(b["queue"]["batches"], 0);
    let text = b.to_string();
    assert!(!text.contains(OUT_MARKER) && !text.contains(IN_SESSION));
    assert!(teamlens::heartbeat::last(&state_db(&ctx)).at.is_some());
}

#[tokio::test]
async fn sync_dang_tam_dung_khong_quet_khong_goi_server() {
    let env = Env::new();
    let server = MockServer::start().await; // không mock gì: gọi server là lỗi
    let ctx = env.ctx(&server.uri());
    state_db(&ctx).set_paused(true, chrono::Utc::now()).unwrap();
    let (r, out) = run_sync(&env, &ctx, false, 8 << 20).await;
    r.unwrap();
    assert!(out.contains("đang tạm dừng"), "{out}");
    assert!(server.received_requests().await.unwrap().is_empty());
    // Không quét: chưa ghi offset file nào.
    let file = env
        .dir
        .path()
        .join("claude/projects/shop")
        .join(format!("{IN_SESSION}.jsonl"));
    assert_eq!(state_db(&ctx).file(&file).unwrap(), None);
}

#[tokio::test]
async fn sync_bo_turn_trong_khoang_tam_dung_giu_seq_goc() {
    // Lần 1 (server khác) để biết ts các turn của session trong phạm vi.
    let env = Env::new();
    let probe = Ingest::new(vec![]);
    let server = server_with(probe.clone()).await;
    let ctx = env.ctx(&server.uri());
    run_sync(&env, &ctx, false, 8 << 20).await.0.unwrap();
    let all: Vec<(u64, String)> = probe.bodies.lock().unwrap()[0]["sessions"][0]["turns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            (
                t["seq"].as_u64().unwrap(),
                t["ts"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let mid: chrono::DateTime<chrono::Utc> = all[all.len() / 2].1.parse().unwrap();

    // Lần 2: môi trường mới, khoảng tạm dừng [mid, bây giờ).
    let env = Env::new();
    let ingest = Ingest::new(vec![]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    state_db(&ctx).set_paused(true, mid).unwrap();
    state_db(&ctx)
        .set_paused(false, chrono::Utc::now())
        .unwrap();
    let (r, out) = run_sync(&env, &ctx, false, 8 << 20).await;
    r.unwrap();
    let expected_dropped = all
        .iter()
        .filter(|(_, ts)| ts.parse::<chrono::DateTime<chrono::Utc>>().unwrap() >= mid)
        .count();
    assert!(expected_dropped > 0);
    assert!(
        out.contains(&format!("Bỏ {expected_dropped} turn trong lúc tạm dừng")),
        "{out}"
    );
    let body = ingest.bodies.lock().unwrap()[0].clone();
    assert_valid_batch(&body);
    let sent: Vec<u64> = body["sessions"][0]["turns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["seq"].as_u64().unwrap())
        .collect();
    let kept: Vec<u64> = all
        .iter()
        .filter(|(_, ts)| ts.parse::<chrono::DateTime<chrono::Utc>>().unwrap() < mid)
        .map(|(seq, _)| *seq)
        .collect();
    assert_eq!(
        sent, kept,
        "giữ nguyên seq gốc của turn ngoài khoảng tạm dừng"
    );

    // Lần sau: file không đổi → không gửi lại turn đã bỏ.
    let (r, out) = run_sync(&env, &ctx, false, 8 << 20).await;
    r.unwrap();
    assert!(out.contains("không đổi"), "{out}");
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 1);

    // `tl preview` cũng bỏ các turn đó.
    let (r, preview_out) = run_preview(&env, &ctx, Some(IN_SESSION.to_owned())).await;
    r.unwrap();
    let batch: Value = serde_json::from_str(&preview_out).unwrap();
    assert_eq!(
        batch["sessions"][0]["turns"].as_array().unwrap().len(),
        kept.len()
    );
}

#[tokio::test]
async fn sync_moi_turn_trong_khoang_tam_dung_thi_khong_gui_session() {
    let env = Env::new();
    let ingest = Ingest::new(vec![]);
    let server = server_with(ingest.clone()).await;
    let ctx = env.ctx(&server.uri());
    let start = chrono::DateTime::<chrono::Utc>::UNIX_EPOCH;
    state_db(&ctx).set_paused(true, start).unwrap();
    state_db(&ctx)
        .set_paused(false, chrono::Utc::now())
        .unwrap();
    let (r, out) = run_sync(&env, &ctx, false, 8 << 20).await;
    r.unwrap();
    assert!(out.contains("Không có session nào mới"), "{out}");
    assert_eq!(ingest.calls.load(Ordering::SeqCst), 0);
}

// ---------------------------------------------------------------------------
// Daemon (M3.2): một chu kỳ `daemon::run_cycle`, thời gian truyền vào (không chờ thật).
// ---------------------------------------------------------------------------

mod daemon_cycle {
    use super::*;
    use std::time::SystemTime;
    use teamlens::daemon::{self, CycleSkip};
    use teamlens::queue;
    use teamlens::state::{state_path, StateDb};

    async fn cycle(env: &Env, ctx: &AppContext, now: SystemTime) -> daemon::CycleReport {
        let conn = teamlens::sync::connect(ctx).await.unwrap();
        daemon::run_cycle(ctx, &env.sources(), &conn, now, 8 << 20)
            .await
            .unwrap()
    }

    fn pending(ctx: &AppContext) -> u64 {
        let db = StateDb::open(&state_path(&ctx.config_path)).unwrap();
        queue::queue_stats(&db).unwrap().pending_batches
    }

    #[tokio::test]
    async fn chu_ky_cho_file_on_dinh_roi_gui_chi_session_trong_pham_vi() {
        let env = Env::new(); // file vừa ghi
        let ingest = Ingest::new(vec![]);
        let server = server_with(ingest.clone()).await;
        let ctx = env.ctx(&server.uri());
        assert!(daemon::last_cycle_at(&ctx).is_none());

        // Lúc này file còn đang ghi: chờ, không gửi.
        let now = SystemTime::now();
        let r = cycle(&env, &ctx, now).await;
        assert!(r.skipped.is_none());
        assert_eq!(r.scan.waiting, 3, "{r:?}");
        assert_eq!(r.sent_batches, 0);
        assert_eq!(ingest.calls.load(Ordering::SeqCst), 0);
        assert!(daemon::last_cycle_at(&ctx).is_some());

        // 3 phút sau (không chờ thật): file đã ổn định → gửi.
        let later = now + Duration::from_secs(180);
        let r = cycle(&env, &ctx, later).await;
        assert_eq!(r.scan.waiting, 0);
        assert_eq!(r.scan.collect.in_scope, 1, "{r:?}");
        assert_eq!(r.scan.collect.out_of_scope, 2);
        assert_eq!(r.sent_batches, 1);
        assert!(r.stop.is_none());
        let bodies = ingest.bodies.lock().unwrap().clone();
        assert_eq!(bodies.len(), 1);
        assert_valid_batch(&bodies[0]);
        assert_clean(&env, &serde_json::to_string(&bodies[0]).unwrap());
        assert_eq!(pending(&ctx), 0);

        // Chu kỳ sau: không đổi gì, không gửi lại.
        let r = cycle(&env, &ctx, later + Duration::from_secs(600)).await;
        assert_eq!(r.scan.unchanged, 3);
        assert_eq!(r.sent_batches, 0);
        assert_eq!(ingest.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn chu_ky_chua_dong_y_khong_quet_khong_gui() {
        let env = Env::new();
        age_logs(&env);
        let ingest = Ingest::new(vec![]);
        let server = server_with(ingest.clone()).await;
        let ctx = env.ctx(&server.uri());
        let conn = teamlens::sync::connect(&ctx).await.unwrap();
        // Rút đồng ý sau khi daemon đã kết nối.
        let ctx = env.ctx_with_consent(&server.uri(), None);
        let r = daemon::run_cycle(&ctx, &env.sources(), &conn, SystemTime::now(), 8 << 20)
            .await
            .unwrap();
        assert_eq!(r.skipped, Some(CycleSkip::NoConsent));
        assert_eq!(r.scan.collect.files, 0);
        assert_eq!(ingest.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn chu_ky_dang_tam_dung_khong_quet_khong_gui() {
        let env = Env::new();
        age_logs(&env);
        let ingest = Ingest::new(vec![]);
        let server = server_with(ingest.clone()).await;
        let ctx = env.ctx(&server.uri());
        StateDb::open(&state_path(&ctx.config_path))
            .unwrap()
            .set_paused(true, chrono::Utc::now())
            .unwrap();
        let r = cycle(&env, &ctx, SystemTime::now()).await;
        assert_eq!(r.skipped, Some(CycleSkip::Paused));
        assert_eq!(r.scan.collect.files, 0);
        assert_eq!(ingest.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn chu_ky_lech_phien_ban_dong_y_hoac_cli_cu_khong_gui() {
        for (body, upgrade) in [
            (config_body("2026-12-01", "0.1.0"), false),
            (config_body(CONSENT_VERSION, "9.9.9"), true),
        ] {
            let env = Env::new();
            age_logs(&env);
            let ingest = Ingest::new(vec![]);
            let server = server_with_config(ingest.clone(), body).await;
            let ctx = env.ctx(&server.uri());
            let r = cycle(&env, &ctx, SystemTime::now()).await;
            assert!(
                matches!(r.skipped, Some(CycleSkip::Blocked(_))),
                "{:?}",
                r.skipped
            );
            assert_eq!(
                r.upgrade_required, upgrade,
                "chỉ CLI cũ mới cần tự cập nhật"
            );
            assert_eq!(ingest.calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn chu_ky_loi_mang_giu_hang_doi_va_ton_trong_backoff() {
        let env = Env::new();
        age_logs(&env);
        let ingest = Ingest::new(vec![ResponseTemplate::new(503)
            .set_body_json(json!({ "error": "unavailable", "message": "bảo trì" }))]);
        let server = server_with(ingest.clone()).await;
        let ctx = env.ctx(&server.uri());
        let now = SystemTime::now();
        let r = cycle(&env, &ctx, now).await;
        assert_eq!(r.enqueued.batches, 1);
        assert_eq!(r.sent_batches, 0);
        assert!(r.stop.is_some());
        let retry_at = r.retry_at.expect("phải hẹn gửi lại");
        assert_eq!(pending(&ctx), 1);
        assert_eq!(ingest.calls.load(Ordering::SeqCst), 1);

        // Ngay sau đó: chưa tới giờ thử lại → không gửi, không xếp hàng trùng.
        let r = cycle(&env, &ctx, now + Duration::from_secs(1)).await;
        assert_eq!(r.enqueued.batches, 0);
        assert_eq!(r.sent_batches, 0);
        assert_eq!(ingest.calls.load(Ordering::SeqCst), 1);
        assert_eq!(r.retry_at, Some(retry_at));

        // Tới giờ hẹn: gửi lại đúng batch đó.
        let r = cycle(
            &env,
            &ctx,
            SystemTime::from(retry_at) + Duration::from_secs(1),
        )
        .await;
        assert_eq!(r.sent_batches, 1);
        assert_eq!(pending(&ctx), 0);
        assert_eq!(ingest.bodies.lock().unwrap().len(), 1);
    }
}
