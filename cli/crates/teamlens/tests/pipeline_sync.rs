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
                    text_version: "2026-11-26".into(),
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

fn whoami_body() -> Value {
    json!({
        "user": { "id": "u1", "email": "member@example.invalid", "name": "Member" },
        "device": { "id": "d1", "name": "MAY-TEST" },
        "projects": [
            { "id": "proj-acme", "name": "Acme", "slug": "acme",
              "repoPatterns": ["github.com/acme/*"] }
        ]
    })
}

async fn mock_whoami(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/agent/v1/whoami"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(whoami_body()))
        .mount(server)
        .await;
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
    mock_whoami(&server).await;
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

async fn run_sync(
    env: &Env,
    ctx: &AppContext,
    dry_run: bool,
    max: usize,
) -> (Result<(), AppError>, String) {
    let mut out = Vec::new();
    let r = sync::run_with(
        ctx,
        SyncArgs {
            once: true,
            dry_run,
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

    // whoami 401 cũng vậy.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/whoami"))
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
