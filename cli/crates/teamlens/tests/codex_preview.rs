//! Test tích hợp `tl preview` với adapter Codex (task M2.5): fixture thật đã che của
//! tl-adapters chép vào `CODEX_HOME` giả, `cwd` đổi sang một repo git giả trong phạm vi.
//! Kiểm tra: tìm session theo `codex:<uuid>`, theo uuid, theo đường dẫn file rollout
//! (chọn đúng adapter Codex dù adapter Claude Code đứng trước), payload đúng schema v1 và
//! không còn đường dẫn tuyệt đối.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use teamlens::commands::preview::{self, PreviewArgs};
use teamlens::config::Config;
use teamlens::consent::{self, ProjectConsent};
use teamlens::context::AppContext;
use teamlens::pipeline::prepare::PrepareOptions;
use teamlens::sync::Sources;
use tempfile::TempDir;
use tl_adapters::claude_code::ClaudeCodeAdapter;
use tl_adapters::codex::CodexAdapter;
use tl_platform::{CredentialStore, MemoryCredentialStore};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TOKEN: &str = "tld_test_token_m25";
const SESSION: &str = "019e1b5f-a9d8-79e0-8e3b-2f26844fb781";
/// `cwd` của fixture (đã che).
const FIXTURE_CWD: &str = r"C:\Users\dev\Documents\demo-app";

struct Env {
    dir: TempDir,
    rollout: PathBuf,
    shop: PathBuf,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let shop = dir.path().join("work").join("shop");
        fs::create_dir_all(shop.join(".git")).unwrap();
        fs::write(
            shop.join(".git/config"),
            "[remote \"origin\"]\n\turl = git@github.com:acme/shop.git\n",
        )
        .unwrap();
        fs::write(shop.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(shop.join("AGENTS.md"), "x".repeat(42)).unwrap();

        let src = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tl-adapters/tests/fixtures/codex/0.130.0-alpha.5/ide-add-file.jsonl");
        let rollout = dir
            .path()
            .join("codex/sessions/2026/05/12")
            .join(format!("rollout-2026-05-12T15-48-34-{SESSION}.jsonl"));
        fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        let shop_s = shop.to_string_lossy().to_string();
        let mut out = String::new();
        for line in fs::read_to_string(src).unwrap().lines() {
            let mut v: Value = serde_json::from_str(line).unwrap();
            map_strings(&mut v, &|s| s.replace(FIXTURE_CWD, &shop_s));
            out.push_str(&serde_json::to_string(&v).unwrap());
            out.push('\n');
        }
        fs::write(&rollout, out).unwrap();
        Env { dir, rollout, shop }
    }

    fn sources(&self) -> Sources {
        Sources {
            adapters: vec![
                Box::new(ClaudeCodeAdapter::new(self.dir.path().join("claude"))),
                Box::new(CodexAdapter::new(self.dir.path().join("codex"))),
            ],
            prepare: PrepareOptions {
                home_dir: Some(self.dir.path().join("home").to_string_lossy().into()),
                user_name: Some("dev".into()),
                host_name: Some("MAY-TEST".into()),
                ..Default::default()
            },
        }
    }

    fn ctx(&self, server: &str) -> AppContext {
        let config_path = self.dir.path().join("teamlens/config.toml");
        let mut config = Config {
            server_url: Some(server.to_owned()),
            ..Default::default()
        };
        consent::record(
            &mut config,
            server,
            ProjectConsent {
                project_id: "proj-acme".into(),
                project_slug: "acme".into(),
                project_name: "Acme".into(),
                text_version: "2026-11-26".into(),
                backfill: true,
                accepted_at: chrono::Utc::now(),
            },
        );
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

fn map_strings(v: &mut Value, f: &dyn Fn(&str) -> String) {
    match v {
        Value::String(s) => *s = f(s),
        Value::Array(a) => a.iter_mut().for_each(|x| map_strings(x, f)),
        Value::Object(o) => {
            // Cả khóa (`patch_apply_end.changes` lấy đường dẫn làm khóa).
            *o = std::mem::take(o)
                .into_iter()
                .map(|(k, mut x)| {
                    map_strings(&mut x, f);
                    (f(&k), x)
                })
                .collect();
        }
        _ => {}
    }
}

async fn server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/whoami"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user": { "id": "u1", "email": "member@example.invalid", "name": "Member" },
            "device": { "id": "d1", "name": "MAY-TEST" },
            "projects": [
                { "id": "proj-acme", "name": "Acme", "slug": "acme",
                  "repoPatterns": ["github.com/acme/*"] }
            ]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/config"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "repo_patterns": [{ "project_id": "proj-acme", "pattern": "github.com/acme/*" }],
            "redaction_patterns": [],
            "truncation": {
                "tool_input_bytes": 4096, "output_head_bytes": 2048, "output_tail_bytes": 1024,
                "diff_bytes": 262144, "thinking_bytes": 8192
            },
            "consent_text_version": "2026-11-26",
            "min_cli_version": "0.1.0"
        })))
        .mount(&server)
        .await;
    server
}

async fn preview(env: &Env, ctx: &AppContext, arg: Option<String>) -> String {
    let mut out = Vec::new();
    let mut note = Vec::new();
    preview::run_with(
        ctx,
        PreviewArgs { session: arg },
        &env.sources(),
        &mut out,
        &mut note,
    )
    .await
    .unwrap();
    String::from_utf8(out).unwrap()
}

fn assert_valid(batch: &Value) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/schema/session.v1.schema.json");
    let schema: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let validator = jsonschema::options()
        .should_validate_formats(true)
        .build(&schema)
        .unwrap();
    let errors: Vec<String> = validator
        .iter_errors(batch)
        .map(|e| format!("{e} tại {}", e.instance_path()))
        .collect();
    assert!(errors.is_empty(), "batch sai schema: {errors:#?}");
}

#[tokio::test]
async fn preview_session_codex_theo_source_id_uuid_va_duong_dan() {
    let env = Env::new();
    let server = server().await;
    let ctx = env.ctx(&server.uri());

    let by_source_id = preview(&env, &ctx, Some(format!("codex:{SESSION}"))).await;
    let batch: Value = serde_json::from_str(&by_source_id).expect("preview phải in JSON");
    assert_valid(&batch);
    let s = &batch["sessions"][0]["session"];
    assert_eq!(s["source_id"], format!("codex:{SESSION}"));
    assert_eq!(s["agent"], "codex");
    assert_eq!(s["agent_version"], "0.130.0-alpha.5");
    assert_eq!(s["repo_remote"], "github.com/acme/shop");
    assert_eq!(s["cwd_relative"], "");
    assert_eq!(s["permission_mode"], "default");
    assert_eq!(
        s["instruction_files"],
        json!([{ "path": "AGENTS.md", "bytes": 42 }])
    );
    let turns = batch["sessions"][0]["turns"].as_array().unwrap();
    let diff = turns
        .iter()
        .find_map(|t| t.get("diff"))
        .expect("apply_patch phải có diff");
    assert_eq!(diff["path"], "file1.md");
    assert!(turns
        .iter()
        .any(|t| t["model"] == "gpt-5.5" && t["reasoning_effort"] == "medium"));
    for needle in [
        env.shop.to_string_lossy().as_ref(),
        r"C:\\Users",
        "C:/Users",
    ] {
        assert!(
            !by_source_id.contains(needle),
            "payload còn đường dẫn tuyệt đối {needle}"
        );
    }

    // Chỉ uuid, hoặc đường dẫn file rollout: cùng session (batch_id khác nhau).
    for arg in [
        SESSION.to_owned(),
        env.rollout.to_string_lossy().into_owned(),
    ] {
        let out = preview(&env, &ctx, Some(arg)).await;
        let other: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(other["sessions"], batch["sessions"]);
    }

    // Không tham số: session gần nhất trong phạm vi chính là session Codex này.
    let latest: Value = serde_json::from_str(&preview(&env, &ctx, None).await).unwrap();
    assert_eq!(
        latest["sessions"][0]["session"]["source_id"],
        format!("codex:{SESSION}")
    );
}
