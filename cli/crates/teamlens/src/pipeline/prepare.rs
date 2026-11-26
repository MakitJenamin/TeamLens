//! Biến một session **đã qua lọc phạm vi** thành [`SessionEnvelope`] sẵn sàng gửi
//! (spec 6.2, 6.3): điền metadata repo → che secret → đổi đường dẫn → cắt.
//!
//! Hàm ở đây chỉ được gọi với session đã có [`RepoScope`] (xem [`super::collect`]);
//! session ngoài phạm vi không bao giờ tới đây.
//!
//! Thứ tự với mỗi chuỗi: che secret trước (để `original_bytes` là kích thước đã che và
//! không secret nào bị cắt đôi rồi lọt regex), rồi đổi đường dẫn tuyệt đối, che tên
//! user Windows/tên máy ([`Identity`]), rồi cắt.

use regex::{Captures, Regex};
use serde_json::Value;
use tl_core::paths::PathContext;
use tl_core::redact::{merge_counts, RedactionCount, Redactor};
use tl_core::session::{redactions_from_counts, Diff, NormalizedSession, SessionEnvelope, Turn};
use tl_core::truncate::{truncate_diff, truncate_output, truncate_tool_input, TruncateLimits};

use super::instructions::instruction_files;
use super::scope::RepoScope;
use crate::api_client::AgentRedactionPattern;

/// Loại che dùng khi bỏ toàn bộ nội dung file nhạy cảm (`.env*`, `*.pem`, `*.key`).
pub const SENSITIVE_FILE_KIND: &str = "sensitive_file";

/// Tùy chọn xử lý.
#[derive(Debug, Clone, Default)]
pub struct PrepareOptions {
    /// Thư mục home của user (để đổi thành `~`). `None` thì bỏ qua quy tắc này.
    pub home_dir: Option<String>,
    /// Tên user Windows (`USERNAME`), thay bằng [`USER_PLACEHOLDER`] (spec 6.3).
    pub user_name: Option<String>,
    /// Tên máy (`COMPUTERNAME`), thay bằng [`HOST_PLACEHOLDER`] (spec 6.3).
    pub host_name: Option<String>,
    /// Ngưỡng cắt (mặc định spec 6.3; `tl sync`/`tl preview` nạp từ `GET /agent/v1/config`).
    pub limits: TruncateLimits,
    /// Pattern che secret bổ sung từ `GET /agent/v1/config` (`redaction_patterns`).
    ///
    /// Chỗ móc cho M2.1: hiện **chưa** áp vào [`Redactor`] (prepare vẫn chỉ dùng bộ pattern có
    /// sẵn); M2.1 biên dịch các pattern này (bỏ pattern lỗi) thành `Redactor` mở rộng và dùng
    /// thay `Redactor::shared()` ở `commands/sync.rs`, `commands/preview.rs`.
    pub server_redaction_patterns: Vec<AgentRedactionPattern>,
}

impl PrepareOptions {
    /// Tùy chọn mặc định của máy đang chạy: home từ `USERPROFILE`/`HOME`, tên user từ
    /// `USERNAME`/`USER` (hoặc tên thư mục home), tên máy từ `COMPUTERNAME`/`HOSTNAME`.
    pub fn from_env() -> Self {
        let var = |keys: &[&str]| {
            keys.iter()
                .filter_map(|k| std::env::var(k).ok())
                .map(|v| v.trim().to_owned())
                .find(|v| !v.is_empty())
        };
        let home_dir = var(&["USERPROFILE", "HOME"]);
        let user_name = var(&["USERNAME", "USER"]).or_else(|| {
            home_dir
                .as_deref()
                .and_then(|h| h.rsplit(['/', '\\']).find(|p| !p.is_empty()))
                .map(str::to_owned)
        });
        Self {
            home_dir,
            user_name,
            host_name: var(&["COMPUTERNAME", "HOSTNAME"]),
            limits: TruncateLimits::default(),
            server_redaction_patterns: Vec::new(),
        }
    }
}

/// Xử lý một session trong phạm vi.
///
/// - `active`: file log còn đang được ghi (chưa "ổn định") → `ended_at = null`.
pub fn prepare_session(
    ns: NormalizedSession,
    scope: &RepoScope,
    redactor: &Redactor,
    opts: &PrepareOptions,
    active: bool,
) -> SessionEnvelope {
    let NormalizedSession {
        cwd,
        mut session,
        turns,
        ..
    } = ns;
    let repo_root = scope.repo_root.to_string_lossy();
    let paths = PathContext::new(Some(&repo_root), opts.home_dir.as_deref());

    session.repo_remote = scope.matched.repo_remote.clone();
    if session.branch.is_none() {
        session.branch = scope.branch.clone();
    }
    session.cwd_relative = cwd
        .as_deref()
        .and_then(|c| cwd_relative(&paths, &c.to_string_lossy()));
    session.instruction_files = Some(instruction_files(&scope.repo_root));
    if active {
        session.ended_at = None;
    }

    let identity = Identity::new(opts.user_name.as_deref(), opts.host_name.as_deref());
    let mut cleaner = Cleaner {
        redactor,
        paths: &paths,
        identity: &identity,
        limits: &opts.limits,
        counts: Vec::new(),
    };
    let turns = turns.into_iter().map(|t| cleaner.turn(t)).collect();
    SessionEnvelope { session, turns }
}

/// `cwd` tuyệt đối → tương đối gốc repo (`""` là chính gốc). Kết quả không nằm trong
/// repo (không nên xảy ra vì repo được tìm từ chính `cwd`) thì trả `None`, không bao giờ
/// gửi đường dẫn tuyệt đối.
fn cwd_relative(paths: &PathContext, cwd: &str) -> Option<String> {
    let rel = paths.relativize_path(cwd);
    if rel == "." {
        return Some(String::new());
    }
    repo_relative(&rel)
}

/// Kết quả của `PathContext::relativize_path` là đường dẫn tương đối gốc repo (không phải
/// `~/...`, `[PATH]/...`, đường dẫn tuyệt đối hay ổ đĩa khác).
fn repo_relative(rel: &str) -> Option<String> {
    let outside = rel.is_empty()
        || rel == "."
        || rel.starts_with(['~', '[', '/', '\\'])
        || rel.contains(':')
        || rel == ".."
        || rel.starts_with("../");
    (!outside).then(|| rel.to_owned())
}

/// Chuỗi thay cho tên user Windows.
pub const USER_PLACEHOLDER: &str = "[USER]";
/// Chuỗi thay cho tên máy.
pub const HOST_PLACEHOLDER: &str = "[HOST]";

/// Tên quá phổ biến: chỉ thay khi đứng sau `Users\` hoặc `Users/` (trong đường dẫn), không thay mọi
/// chỗ xuất hiện để khỏi làm hỏng văn bản.
const COMMON_NAMES: &[&str] = &[
    "admin",
    "administrator",
    "default",
    "desktop",
    "dev",
    "guest",
    "home",
    "laptop",
    "owner",
    "public",
    "root",
    "test",
    "user",
];

/// Che tên user Windows và tên máy còn sót sau khi đổi đường dẫn: tên thư mục mã hóa
/// kiểu `C--Users-<tên>-...` của Claude Code, output `hostname`/`whoami`, `tl status`...
struct Identity {
    /// `Users\<tên>`, `Users/<tên>`, `Users-<tên>` (luôn áp dụng).
    in_path: Option<Regex>,
    /// Tên đứng riêng (chỉ với tên đủ đặc trưng).
    words: Option<Regex>,
    user: Option<String>,
}

impl Identity {
    fn new(user: Option<&str>, host: Option<&str>) -> Self {
        let clean = |s: Option<&str>| {
            s.map(str::trim)
                .filter(|s| s.chars().count() >= 3)
                .map(str::to_owned)
        };
        let user = clean(user);
        let host = clean(host);
        let distinctive = |n: &String| {
            n.chars().count() >= 4 && !COMMON_NAMES.contains(&n.to_lowercase().as_str())
        };
        let in_path = user
            .as_ref()
            .and_then(|u| Regex::new(&format!(r"(?i)(Users[\\/\-]+){}\b", regex::escape(u))).ok());
        let words: Vec<String> = user
            .iter()
            .chain(host.iter())
            .filter(|n| distinctive(n))
            .map(|n| regex::escape(n))
            .collect();
        let words = (!words.is_empty())
            .then(|| Regex::new(&format!(r"(?i)\b(?:{})\b", words.join("|"))).ok())
            .flatten();
        Self {
            in_path,
            words,
            user: user.map(|u| u.to_lowercase()),
        }
    }

    fn scrub(&self, s: String) -> String {
        let mut s = s;
        if let Some(re) = &self.in_path {
            if re.is_match(&s) {
                s = re
                    .replace_all(&s, format!("${{1}}{USER_PLACEHOLDER}"))
                    .into_owned();
            }
        }
        if let Some(re) = &self.words {
            if re.is_match(&s) {
                s = re
                    .replace_all(&s, |c: &Captures| {
                        if self.user.as_deref() == Some(c[0].to_lowercase().as_str()) {
                            USER_PLACEHOLDER
                        } else {
                            HOST_PLACEHOLDER
                        }
                    })
                    .into_owned();
            }
        }
        s
    }
}

/// Bộ xử lý chuỗi cho một session, gom số lần che của turn đang xử lý.
struct Cleaner<'a> {
    redactor: &'a Redactor,
    paths: &'a PathContext,
    identity: &'a Identity,
    limits: &'a TruncateLimits,
    counts: Vec<RedactionCount>,
}

impl Cleaner<'_> {
    /// Che secret rồi đổi đường dẫn trong văn bản tự do.
    fn text(&mut self, s: &str) -> String {
        let r = self.redactor.redact(s);
        self.counts.extend(r.redactions);
        self.identity.scrub(self.paths.relativize_text(&r.text))
    }

    /// Thay toàn bộ nội dung bằng dấu che file nhạy cảm.
    fn sensitive(&mut self) -> String {
        self.counts.push(RedactionCount {
            kind: SENSITIVE_FILE_KIND.to_owned(),
            count: 1,
        });
        format!("[REDACTED:{SENSITIVE_FILE_KIND}]")
    }

    fn turn(&mut self, mut t: Turn) -> Turn {
        self.counts.clear();
        // Turn adapter đã có `redactions` (hiện chưa có adapter nào làm) thì cộng dồn.
        self.counts
            .extend(t.redactions.drain(..).map(|r| RedactionCount {
                kind: r.kind,
                count: r.count,
            }));

        let sensitive = touches_sensitive_file(&t);

        if let Some(text) = t.text.take() {
            t.text = Some(self.text(&text));
        }
        if let Some(input) = t.tool.as_mut().and_then(|tool| tool.input.as_mut()) {
            for (key, value) in input.iter_mut() {
                self.input_value(key, value, sensitive);
            }
        }
        if let Some(output) = t.output.as_mut() {
            let cleaned = if sensitive {
                self.sensitive()
            } else {
                self.text(&output.text)
            };
            let cut = truncate_output(&cleaned, self.limits);
            output.text = cut.text;
            if cut.truncated {
                output.truncated = true;
                output.original_bytes = Some(cut.original_bytes as u64);
            }
        }
        // Diff của file ngoài repo (`~/...`, `[PATH]/...`, ổ đĩa khác): bỏ hẳn. Schema
        // chỉ nhận đường dẫn tương đối gốc repo, và nội dung file ngoài repo không gửi.
        if let Some(diff) = t.diff.take() {
            t.diff = repo_relative(&self.paths.relativize_path(&diff.path)).map(|path| Diff {
                path: self.identity.scrub(path),
                ..diff
            });
        }
        if let Some(diff) = t.diff.as_mut() {
            let cleaned = if sensitive {
                self.sensitive()
            } else {
                self.text(&diff.patch)
            };
            diff.patch = truncate_diff(&cleaned, self.limits).text;
        }

        let lists = [self.counts.as_slice()];
        t.redactions = redactions_from_counts(merge_counts(lists));
        t
    }

    /// Xử lý từng chuỗi lồng trong `tool.input` (không cắt JSON nguyên khối, để input
    /// vẫn là object hợp lệ). `key` là tên khóa gần nhất, dùng để nhận ra trường đường dẫn.
    fn input_value(&mut self, key: &str, value: &mut Value, sensitive: bool) {
        match value {
            Value::String(s) => {
                let path_key = is_path_key(key);
                let cleaned = if path_key {
                    let r = self.redactor.redact(s);
                    self.counts.extend(r.redactions);
                    self.identity.scrub(self.paths.relativize_path(&r.text))
                } else if sensitive {
                    // Nội dung ghi vào/sửa trong file nhạy cảm: bỏ toàn bộ.
                    self.sensitive()
                } else {
                    self.text(s)
                };
                *s = truncate_tool_input(&cleaned, self.limits).text;
            }
            Value::Array(items) => {
                for item in items {
                    self.input_value(key, item, sensitive);
                }
            }
            Value::Object(map) => {
                for (k, v) in map.iter_mut() {
                    self.input_value(k, v, sensitive);
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
    }
}

/// Khóa trong `tool.input` chứa đúng một đường dẫn (`file_path`, `path`, `notebook_path`, `cwd`...).
fn is_path_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k == "cwd" || k == "dir" || k.ends_with("path")
}

/// Turn đọc/sửa file nhạy cảm (`.env*`, `*.pem`, `*.key`) — spec 6.2: bỏ toàn bộ output.
fn touches_sensitive_file(t: &Turn) -> bool {
    let from_input = t
        .tool
        .as_ref()
        .and_then(|tool| tool.input.as_ref())
        .is_some_and(|input| {
            input
                .iter()
                .any(|(k, v)| is_path_key(k) && v.as_str().is_some_and(is_sensitive_path))
        });
    from_input || t.diff.as_ref().is_some_and(|d| is_sensitive_path(&d.path))
}

/// `.env`, `.env.local`, `server.pem`, `id.key`... (không phân biệt hoa thường).
pub fn is_sensitive_path(path: &str) -> bool {
    let name = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase();
    name.starts_with(".env") || name.ends_with(".pem") || name.ends_with(".key")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use chrono::{TimeZone, Utc};
    use serde_json::json;
    use tl_core::scope::{RepoPatterns, ScopeDecision};
    use tl_core::session::{AgentKind, Diff, Output, Role, Session, Tool, ToolStatus, TurnKind};

    const ROOT: &str = r"C:\Users\alice\code\shop";

    fn scope() -> RepoScope {
        let mut patterns = RepoPatterns::new();
        patterns.add("p1", "github.com/acme/*");
        let ScopeDecision::InScope(matched) = patterns.decide(["git@github.com:acme/shop.git"])
        else {
            panic!("phải khớp");
        };
        RepoScope {
            matched,
            repo_root: PathBuf::from(ROOT),
            branch: Some("main".into()),
        }
    }

    fn session() -> NormalizedSession {
        let ts = Utc.with_ymd_and_hms(2026, 11, 26, 9, 0, 0).unwrap();
        let mut call = Turn::new(1, Role::Assistant, TurnKind::ToolCall, ts);
        call.tool = Some(Tool {
            name: "Bash".into(),
            input: Some(
                json!({
                    "command": format!("cd {ROOT}\\api && echo AKIAIOSFODNN7EXAMPLE"),
                    "file_path": format!("{ROOT}\\src\\main.rs"),
                    "nested": { "list": ["x".repeat(10_000)] },
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
            status: None,
        });
        let mut result = Turn::new(2, Role::User, TurnKind::ToolResult, ts);
        result.tool = Some(Tool {
            name: "Bash".into(),
            input: None,
            status: Some(ToolStatus::Ok),
        });
        result.output = Some(Output {
            text: format!("{ROOT}\\log.txt\n{}", "y".repeat(20_000)),
            truncated: false,
            original_bytes: None,
        });
        let mut edit = Turn::new(3, Role::Assistant, TurnKind::ToolCall, ts);
        edit.tool = Some(Tool {
            name: "Edit".into(),
            input: Some(
                json!({ "file_path": format!("{ROOT}\\.env.local"), "new_string": "TOKEN=abc" })
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
            status: None,
        });
        edit.diff = Some(Diff {
            path: format!("{ROOT}\\.env.local"),
            patch: "+TOKEN=abc\n".into(),
            added: 1,
            removed: 0,
        });
        let mut prompt = Turn::new(0, Role::User, TurnKind::Prompt, ts);
        prompt.text = Some("Dùng key sk-ant-api03-abcdefghijklmnopqrstuvwxyz nhé".into());
        // Sửa file ngoài repo (ghi chú trong home).
        let mut outside = Turn::new(4, Role::Assistant, TurnKind::ToolCall, ts);
        outside.diff = Some(Diff {
            path: r"C:\Users\alice\notes\todo.md".into(),
            patch: "+việc riêng\n".into(),
            added: 1,
            removed: 0,
        });
        NormalizedSession {
            cwd: Some(PathBuf::from(format!("{ROOT}\\api"))),
            session: Session {
                source_id: "claude_code:s1".into(),
                agent: AgentKind::ClaudeCode,
                agent_version: Some("2.1.332".into()),
                repo_remote: String::new(),
                branch: None,
                cwd_relative: None,
                started_at: ts,
                ended_at: Some(ts),
                parent_source_id: None,
                permission_mode: None,
                instruction_files: None,
            },
            turns: vec![prompt, call, result, edit, outside],
            parse_warnings: 0,
        }
    }

    #[test]
    fn che_doi_duong_dan_va_cat() {
        let opts = PrepareOptions {
            home_dir: Some(r"C:\Users\alice".into()),
            user_name: Some("alice".into()),
            host_name: Some("MAY-ALICE".into()),
            limits: TruncateLimits::default(),
            server_redaction_patterns: Vec::new(),
        };
        let env = prepare_session(session(), &scope(), Redactor::shared(), &opts, true);
        let s = &env.session;
        assert_eq!(s.repo_remote, "github.com/acme/shop");
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.cwd_relative.as_deref(), Some("api"));
        assert_eq!(s.ended_at, None, "file đang ghi thì ended_at = null");
        assert!(s.instruction_files.is_some());

        let json = serde_json::to_string(&env).unwrap();
        assert!(!json.contains("alice"), "còn đường dẫn cá nhân: {json}");
        assert!(!json.contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(!json.contains("sk-ant-api03"));
        assert!(!json.contains("TOKEN=abc"));

        let t = &env.turns;
        assert_eq!(t[0].redactions[0].kind, "anthropic_api_key");
        let input = t[1].tool.as_ref().unwrap().input.as_ref().unwrap();
        assert_eq!(input["file_path"], "src/main.rs");
        assert!(input["command"]
            .as_str()
            .unwrap()
            .starts_with("cd api && echo"));
        let long = input["nested"]["list"][0].as_str().unwrap();
        assert!(long.len() < 5_000 && long.contains("[đã cắt"));
        assert_eq!(t[1].redactions[0].kind, "aws_access_key");

        let out = t[2].output.as_ref().unwrap();
        assert!(out.truncated);
        assert!(out.original_bytes.unwrap() > 20_000);
        assert!(out.text.starts_with("log.txt\n"));

        let diff = t[3].diff.as_ref().unwrap();
        assert_eq!(diff.path, ".env.local");
        assert_eq!(diff.patch, "[REDACTED:sensitive_file]");
        assert!(t[3]
            .redactions
            .iter()
            .any(|r| r.kind == SENSITIVE_FILE_KIND && r.count == 2));
        assert_eq!(t[4].diff, None, "diff file ngoài repo phải bị bỏ");
        assert!(!json.contains("việc riêng"));
    }

    #[test]
    fn che_ten_user_va_ten_may() {
        let id = Identity::new(Some("alice"), Some("MAY-ALICE"));
        assert_eq!(
            id.scrub("~/.claude/projects/C--Users-Alice-code-shop/x.jsonl".into()),
            "~/.claude/projects/C--Users-[USER]-code-shop/x.jsonl"
        );
        assert_eq!(
            id.scrub("Thiết bị: may-alice, chủ alice; malice không đổi".into()),
            "Thiết bị: [HOST], chủ [USER]; malice không đổi"
        );
        // Tên phổ biến: chỉ thay trong đường dẫn.
        let id = Identity::new(Some("dev"), None);
        assert_eq!(
            id.scrub(r"D:\Users\dev\x và dev server".into()),
            r"D:\Users\[USER]\x và dev server"
        );
        let id = Identity::new(None, None);
        assert_eq!(id.scrub("không đổi".into()), "không đổi");
    }

    #[test]
    fn cwd_o_goc_repo_la_chuoi_rong() {
        let paths = PathContext::new(Some(ROOT), None);
        assert_eq!(cwd_relative(&paths, ROOT).as_deref(), Some(""));
        assert_eq!(cwd_relative(&paths, r"D:\khac").as_deref(), None);
    }

    #[test]
    fn nhan_ra_file_nhay_cam() {
        for p in [".env", "a/.env.production", r"C:\x\server.PEM", "id.key"] {
            assert!(is_sensitive_path(p), "{p}");
        }
        for p in ["src/env.rs", "keys.rs", "README.md"] {
            assert!(!is_sensitive_path(p), "{p}");
        }
    }
}
