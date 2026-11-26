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
use tl_core::sensitive::command_reads_sensitive_file;
pub use tl_core::sensitive::is_sensitive_path;
use tl_core::session::{
    redactions_from_counts, Diff, NormalizedSession, SessionEnvelope, Turn, TurnKind,
};
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
    /// `tl sync`/`tl preview` biên dịch chúng thành bộ che mở rộng bằng [`build_redactor`].
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

/// Bộ che secret cho một lần chạy: rule có sẵn + `redaction_patterns` của server.
///
/// Không có pattern server thì dùng lại [`Redactor::shared()`] (không biên dịch lại). Pattern
/// lỗi (regex sai, id rỗng, quá nặng) bị bỏ qua; trả về kèm danh sách cảnh báo tiếng Việt để
/// nơi gọi in ra. Rule có sẵn luôn còn nguyên.
pub fn build_redactor(
    patterns: &[AgentRedactionPattern],
) -> (std::borrow::Cow<'static, Redactor>, Vec<String>) {
    if patterns.is_empty() {
        return (std::borrow::Cow::Borrowed(Redactor::shared()), Vec::new());
    }
    let (redactor, errors) =
        Redactor::with_external(patterns.iter().map(|p| (p.id.as_str(), p.regex.as_str())));
    let warnings = errors
        .iter()
        .map(|e| {
            // Lỗi regex nhiều dòng (có mũi tên chỉ vị trí): gộp thành một dòng.
            let msg = e
                .to_string()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            format!("Bỏ qua pattern che secret từ server: {msg}")
        })
        .collect();
    (std::borrow::Cow::Owned(redactor), warnings)
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
        pending_calls: Vec::new(),
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
    /// Lượt gọi tool chưa thấy kết quả: (tên tool, có đọc file nhạy cảm không), theo
    /// thứ tự xuất hiện. Kết quả tool (`tool_result`) là turn riêng không có input, nên
    /// ghép với lượt gọi cùng tên còn chờ sớm nhất để biết có phải bỏ output không.
    pending_calls: Vec<(String, bool)>,
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

        // Ghi/sửa file nhạy cảm (input và diff bị bỏ); đọc file nhạy cảm (output bị bỏ).
        let sensitive = touches_sensitive_file(&t);
        let reads_sensitive = sensitive || reads_sensitive_file(&t);
        let tool_name = t.tool.as_ref().map(|tool| tool.name.clone());
        let output_sensitive = match (t.kind, tool_name) {
            (TurnKind::ToolCall, Some(name)) => {
                self.pending_calls.push((name, reads_sensitive));
                reads_sensitive
            }
            (TurnKind::ToolResult, Some(name)) => {
                let call = self.pending_calls.iter().position(|(n, _)| *n == name);
                let from_call = call.is_some_and(|i| self.pending_calls.remove(i).1);
                from_call || reads_sensitive
            }
            _ => reads_sensitive,
        };

        if let Some(text) = t.text.take() {
            t.text = Some(self.text(&text));
        }
        if let Some(input) = t.tool.as_mut().and_then(|tool| tool.input.as_mut()) {
            for (key, value) in input.iter_mut() {
                self.input_value(key, value, sensitive);
            }
        }
        if let Some(output) = t.output.as_mut() {
            let cleaned = if output_sensitive {
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

/// Turn chạy lệnh shell in nội dung file nhạy cảm (`cat .env`, `Get-Content x.pem`...).
/// Claude Code: `Bash`/`PowerShell` với `command` là chuỗi; Codex: `command` là mảng
/// (`["bash", "-lc", "..."]`) hoặc `cmd` là chuỗi.
fn reads_sensitive_file(t: &Turn) -> bool {
    let Some(input) = t.tool.as_ref().and_then(|tool| tool.input.as_ref()) else {
        return false;
    };
    ["command", "cmd", "script"].iter().any(|key| {
        let command = match input.get(*key) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
            _ => return false,
        };
        command_reads_sensitive_file(&command)
    })
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

    fn call(seq: u32, name: &str, input: Value) -> Turn {
        let ts = Utc.with_ymd_and_hms(2026, 11, 26, 9, 0, 0).unwrap();
        let mut t = Turn::new(seq, Role::Assistant, TurnKind::ToolCall, ts);
        t.tool = Some(Tool {
            name: name.into(),
            input: input.as_object().cloned(),
            status: Some(ToolStatus::Ok),
        });
        t
    }

    fn result(seq: u32, name: &str, text: &str) -> Turn {
        let ts = Utc.with_ymd_and_hms(2026, 11, 26, 9, 0, 0).unwrap();
        let mut t = Turn::new(seq, Role::User, TurnKind::ToolResult, ts);
        t.tool = Some(Tool {
            name: name.into(),
            input: None,
            status: Some(ToolStatus::Ok),
        });
        t.output = Some(Output {
            text: text.into(),
            truncated: false,
            original_bytes: None,
        });
        t
    }

    fn run(turns: Vec<Turn>) -> SessionEnvelope {
        let mut ns = session();
        ns.turns = turns;
        let opts = PrepareOptions {
            home_dir: Some(r"C:\Users\alice".into()),
            user_name: Some("alice".into()),
            host_name: None,
            limits: TruncateLimits::default(),
            server_redaction_patterns: Vec::new(),
        };
        prepare_session(ns, &scope(), Redactor::shared(), &opts, false)
    }

    fn output(t: &Turn) -> &str {
        &t.output.as_ref().unwrap().text
    }

    const ENV_BODY: &str = "DB_HOST=localhost\nFEATURE_FLAG=on\n";

    #[test]
    fn drops_output_when_reading_sensitive_file() {
        let env = run(vec![
            // Read của Claude Code: kết quả là turn riêng, không có input.
            call(
                0,
                "Read",
                json!({ "file_path": format!("{ROOT}\\apps\\api\\.env") }),
            ),
            result(1, "Read", ENV_BODY),
            // Lệnh shell đọc file.
            call(
                2,
                "Bash",
                json!({ "command": "cat apps/api/.env.local | grep DB" }),
            ),
            result(3, "Bash", ENV_BODY),
            call(
                4,
                "PowerShell",
                json!({ "command": "Get-Content certs\\server.pem" }),
            ),
            result(5, "PowerShell", "-----BEGIN CERTIFICATE-----"),
            // Codex: command là mảng.
            call(
                6,
                "shell",
                json!({ "command": ["bash", "-lc", "head -5 .env"] }),
            ),
            result(7, "shell", ENV_BODY),
            // Lệnh thường: giữ output.
            call(8, "Bash", json!({ "command": "cat README.md" })),
            result(9, "Bash", "# Shop"),
        ]);
        let t = &env.turns;
        for i in [1, 3, 5, 7] {
            assert_eq!(output(&t[i]), "[REDACTED:sensitive_file]", "turn {i}");
            assert_eq!(t[i].redactions[0].kind, SENSITIVE_FILE_KIND);
            assert_eq!(t[i].redactions[0].count, 1);
        }
        assert_eq!(output(&t[9]), "# Shop");
        assert!(t[9].redactions.is_empty());
        // Câu lệnh vẫn giữ (đã qua bộ che thường).
        let cmd = &t[2].tool.as_ref().unwrap().input.as_ref().unwrap()["command"];
        assert_eq!(cmd, "cat apps/api/.env.local | grep DB");
        let json = serde_json::to_string(&env).unwrap();
        assert!(!json.contains("FEATURE_FLAG"));
    }

    #[test]
    fn pairs_results_with_parallel_calls() {
        // Hai lượt gọi Read song song rồi hai kết quả theo đúng thứ tự.
        let env = run(vec![
            call(0, "Read", json!({ "file_path": "README.md" })),
            call(1, "Read", json!({ "file_path": ".env" })),
            result(2, "Read", "# Shop"),
            result(3, "Read", ENV_BODY),
        ]);
        assert_eq!(output(&env.turns[2]), "# Shop");
        assert_eq!(output(&env.turns[3]), "[REDACTED:sensitive_file]");
    }

    #[test]
    fn keeps_env_template_files() {
        // Quyết định M2.1: `.env.example`/`.env.sample` được giữ, vẫn qua bộ che thường.
        let key = format!("{}{}", "ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
        let body = format!("DB_HOST=localhost\nGITHUB_TOKEN={key}\n");
        let env = run(vec![
            call(0, "Read", json!({ "file_path": ".env.example" })),
            result(1, "Read", &body),
            call(2, "Bash", json!({ "command": "cat .env.sample" })),
            result(3, "Bash", "DB_HOST=localhost"),
        ]);
        let out = output(&env.turns[1]);
        assert!(out.contains("DB_HOST=localhost"));
        assert!(out.contains("[REDACTED:github_token]"));
        assert!(!out.contains(&key));
        assert_eq!(output(&env.turns[3]), "DB_HOST=localhost");
    }

    #[test]
    fn redacts_secrets_everywhere() {
        let ts = Utc.with_ymd_and_hms(2026, 11, 26, 9, 0, 0).unwrap();
        let aws = format!("{}{}", "AKIA", "IOSFODNN7EXAMPLE");
        let gl = format!("{}{}", "glpat-", "Ab12Cd34Ef56Gh78Ij90");
        let hf = format!("{}{}", "hf_", "AbCdEfGhIjKlMnOpQrStUvWxYz01234567");
        let npm = format!("{}{}", "npm_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
        let pg = "postgres://app:Sup3rS3cret@db:5432/app";

        let mut prompt = Turn::new(0, Role::User, TurnKind::Prompt, ts);
        prompt.text = Some(format!("dùng khóa {aws} nhé"));
        let mut reply = Turn::new(1, Role::Assistant, TurnKind::Reply, ts);
        reply.text = Some(format!("Đã thêm token {gl} vào CI"));
        let mut edit = call(
            2,
            "Edit",
            json!({ "file_path": "src/db.ts", "new_string": pg }),
        );
        edit.diff = Some(Diff {
            path: "src/db.ts".into(),
            patch: format!("+const t = \"{npm}\";\n"),
            added: 1,
            removed: 0,
        });
        let res = result(3, "Edit", &format!("ok {hf}"));

        let env = run(vec![prompt, reply, edit, res]);
        let json = serde_json::to_string(&env).unwrap();
        for secret in [aws.as_str(), &gl, &hf, &npm, "Sup3rS3cret"] {
            assert!(!json.contains(secret), "lọt {secret}");
        }
        let kinds = |i: usize| -> Vec<String> {
            env.turns[i]
                .redactions
                .iter()
                .map(|r| r.kind.clone())
                .collect()
        };
        assert_eq!(kinds(0), ["aws_access_key"]);
        assert_eq!(kinds(1), ["gitlab_pat"]);
        assert_eq!(kinds(2), ["npm_token", "url_password"]);
        assert_eq!(kinds(3), ["huggingface_token"]);
    }

    #[test]
    fn server_patterns_extend_builtin_redactor() {
        let (r, warnings) = build_redactor(&[]);
        assert!(warnings.is_empty());
        assert!(std::ptr::eq(r.as_ref(), Redactor::shared()));

        let patterns = vec![
            AgentRedactionPattern {
                id: "acme_internal".into(),
                regex: r"\bACME-[0-9]{6}\b".into(),
            },
            AgentRedactionPattern {
                id: "broken".into(),
                regex: "(unclosed".into(),
            },
        ];
        let (r, warnings) = build_redactor(&patterns);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("broken"), "{warnings:?}");
        let aws = format!("{}{}", "AKIA", "IOSFODNN7EXAMPLE");
        let out = r.redact(&format!("mã ACME-123456 và {aws}"));
        assert_eq!(
            out.text,
            "mã [REDACTED:acme_internal] và [REDACTED:aws_access_key]"
        );
    }
}
