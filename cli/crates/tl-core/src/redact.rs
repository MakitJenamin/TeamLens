//! Che secret trước khi gửi (spec mục 6.2) — task M1.5 (cơ bản), M2.1 (đầy đủ).
//!
//! Mỗi loại secret là một [`Rule`] có tên (`kind`, dạng `^[a-z0-9_]+$`, khớp
//! `Redaction.type` trong schema session v1) và một regex. [`Redactor`] chạy mọi
//! rule trên văn bản gốc, gộp các vùng trùng nhau rồi thay mỗi vùng bằng
//! `[REDACTED:<kind>]`, đồng thời đếm số lần che theo loại.
//!
//! Mở rộng (M2.1): thêm rule có sẵn vào [`builtin_rules`], hoặc nạp pattern lúc
//! chạy (ví dụ admin cấu hình trên server) bằng [`Redactor::add_pattern`].
//!
//! ```
//! use tl_core::redact::Redactor;
//!
//! let out = Redactor::shared().redact("DB_PASSWORD=hunter22 xong");
//! assert_eq!(out.text, "DB_PASSWORD=[REDACTED:secret_assignment] xong");
//! assert_eq!(out.redactions[0].kind, "secret_assignment");
//! assert_eq!(out.redactions[0].count, 1);
//! ```
//!
//! Đổi đường dẫn tuyệt đối nằm ở module [`crate::paths`].

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;

/// Tên capture group đánh dấu phần cần che. Rule không có group này thì che cả
/// chuỗi khớp.
pub const SECRET_GROUP: &str = "secret";

/// Lỗi khi tạo [`Rule`] (thường do pattern nạp lúc chạy không hợp lệ).
#[derive(Debug, thiserror::Error)]
pub enum RedactError {
    /// Tên loại secret không khớp `^[a-z0-9_]+$`.
    #[error("tên loại secret không hợp lệ: {0:?} (chỉ dùng a-z, 0-9, _)")]
    InvalidKind(String),
    /// Regex không biên dịch được.
    #[error("pattern của loại {kind} không hợp lệ: {source}")]
    InvalidPattern {
        /// Tên loại secret.
        kind: String,
        /// Lỗi từ crate `regex`.
        #[source]
        source: regex::Error,
    },
}

/// Một luật che secret: tên loại + regex (+ bộ lọc tùy chọn).
///
/// Nếu regex có capture group tên `secret` ([`SECRET_GROUP`]) thì chỉ phần đó
/// bị che (ví dụ chỉ che mật khẩu trong `postgres://user:pass@host`), ngược lại
/// che cả chuỗi khớp.
#[derive(Debug, Clone)]
pub struct Rule {
    kind: String,
    regex: Regex,
    accept: Option<fn(&str) -> bool>,
}

impl Rule {
    /// Tạo rule từ tên loại và pattern (cú pháp crate `regex`).
    ///
    /// # Errors
    /// [`RedactError::InvalidKind`] nếu `kind` không khớp `^[a-z0-9_]+$`,
    /// [`RedactError::InvalidPattern`] nếu regex lỗi.
    pub fn new(kind: impl Into<String>, pattern: &str) -> Result<Self, RedactError> {
        let kind = kind.into();
        let valid = !kind.is_empty()
            && kind
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        if !valid {
            return Err(RedactError::InvalidKind(kind));
        }
        let regex = Regex::new(pattern).map_err(|source| RedactError::InvalidPattern {
            kind: kind.clone(),
            source,
        })?;
        Ok(Self {
            kind,
            regex,
            accept: None,
        })
    }

    /// Thêm bộ lọc: chuỗi khớp chỉ bị che khi `accept` trả `true`
    /// (dùng để loại giá trị giữ chỗ như `true`, `${VAR}`...).
    #[must_use]
    pub fn with_filter(mut self, accept: fn(&str) -> bool) -> Self {
        self.accept = Some(accept);
        self
    }

    /// Tên loại secret, dùng trong `[REDACTED:<kind>]` và `Redaction.type`.
    pub fn kind(&self) -> &str {
        &self.kind
    }
}

/// Số lần che của một loại secret, tương ứng `Redaction` trong schema v1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedactionCount {
    /// Tên loại secret (`Redaction.type`).
    pub kind: String,
    /// Số vùng đã che (luôn ≥ 1).
    pub count: u32,
}

/// Kết quả của [`Redactor::redact`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redacted {
    /// Văn bản đã che.
    pub text: String,
    /// Số lần che theo loại, sắp theo `kind`; rỗng nếu không che gì.
    pub redactions: Vec<RedactionCount>,
}

/// Gộp nhiều danh sách đếm (ví dụ của text, tool input, output trong cùng
/// một turn) thành một danh sách sắp theo `kind`.
pub fn merge_counts<'a>(
    lists: impl IntoIterator<Item = &'a [RedactionCount]>,
) -> Vec<RedactionCount> {
    let mut map: BTreeMap<&str, u32> = BTreeMap::new();
    for list in lists {
        for item in list {
            *map.entry(item.kind.as_str()).or_default() += item.count;
        }
    }
    map.into_iter()
        .map(|(kind, count)| RedactionCount {
            kind: kind.to_owned(),
            count,
        })
        .collect()
}

/// Bộ che secret: danh sách [`Rule`] theo thứ tự ưu tiên.
///
/// Khi nhiều rule khớp chồng lên nhau, các vùng được gộp lại (che phần hợp của
/// chúng) và gắn nhãn theo rule đứng trước trong danh sách. Vì vậy rule cụ thể
/// (JWT, khóa Anthropic...) phải đứng trước rule chung (`secret_assignment`).
#[derive(Debug, Clone)]
pub struct Redactor {
    rules: Vec<Rule>,
}

static SHARED: LazyLock<Redactor> = LazyLock::new(Redactor::builtin);

impl Redactor {
    /// Bộ che chỉ gồm các rule có sẵn ([`builtin_rules`]).
    pub fn builtin() -> Self {
        Self {
            rules: builtin_rules(),
        }
    }

    /// Bộ che dùng chung (rule có sẵn), biên dịch regex một lần cho cả tiến trình.
    pub fn shared() -> &'static Redactor {
        &SHARED
    }

    /// Bộ che từ danh sách rule tùy ý (giữ nguyên thứ tự ưu tiên).
    pub fn from_rules(rules: Vec<Rule>) -> Self {
        Self { rules }
    }

    /// Thêm một rule vào cuối danh sách (ưu tiên thấp nhất).
    pub fn push_rule(&mut self, rule: Rule) {
        self.rules.push(rule);
    }

    /// Biên dịch và thêm pattern nạp lúc chạy (ví dụ từ `GET /agent/v1/config`).
    ///
    /// # Errors
    /// Như [`Rule::new`]; khi lỗi, bộ che giữ nguyên.
    pub fn add_pattern(
        &mut self,
        kind: impl Into<String>,
        pattern: &str,
    ) -> Result<(), RedactError> {
        self.push_rule(Rule::new(kind, pattern)?);
        Ok(())
    }

    /// Các rule hiện có, theo thứ tự ưu tiên.
    pub fn rules(&self) -> &[Rule] {
        &self.rules
    }

    /// Che mọi secret trong `text`.
    ///
    /// Hàm idempotent: chạy lại trên kết quả không che thêm gì (marker
    /// `[REDACTED:...]` không khớp rule có sẵn nào).
    pub fn redact(&self, text: &str) -> Redacted {
        // (start, end, chỉ số rule)
        let mut spans: Vec<(usize, usize, usize)> = Vec::new();
        for (idx, rule) in self.rules.iter().enumerate() {
            for caps in rule.regex.captures_iter(text) {
                let Some(m) = caps.name(SECRET_GROUP).or_else(|| caps.get(0)) else {
                    continue;
                };
                // Bỏ qua chuỗi rỗng, chuỗi đã che (giữ tính idempotent) và chuỗi bộ lọc loại.
                if m.is_empty()
                    || m.as_str().starts_with("[REDACTED:")
                    || rule.accept.is_some_and(|f| !f(m.as_str()))
                {
                    continue;
                }
                spans.push((m.start(), m.end(), idx));
            }
        }
        if spans.is_empty() {
            return Redacted {
                text: text.to_owned(),
                redactions: Vec::new(),
            };
        }

        // Gộp các vùng chồng nhau, nhãn theo rule ưu tiên cao nhất (chỉ số nhỏ nhất).
        spans.sort_unstable();
        let mut merged: Vec<(usize, usize, usize)> = Vec::with_capacity(spans.len());
        for (start, end, idx) in spans {
            match merged.last_mut() {
                Some(last) if start < last.1 => {
                    last.1 = last.1.max(end);
                    last.2 = last.2.min(idx);
                }
                _ => merged.push((start, end, idx)),
            }
        }

        let mut out = String::with_capacity(text.len());
        let mut counts: BTreeMap<&str, u32> = BTreeMap::new();
        let mut pos = 0;
        for (start, end, idx) in merged {
            let kind = self.rules[idx].kind.as_str();
            out.push_str(&text[pos..start]);
            out.push_str("[REDACTED:");
            out.push_str(kind);
            out.push(']');
            *counts.entry(kind).or_default() += 1;
            pos = end;
        }
        out.push_str(&text[pos..]);

        Redacted {
            text: out,
            redactions: counts
                .into_iter()
                .map(|(kind, count)| RedactionCount {
                    kind: kind.to_owned(),
                    count,
                })
                .collect(),
        }
    }
}

impl Default for Redactor {
    fn default() -> Self {
        Self::builtin()
    }
}

/// Bỏ qua giá trị rõ ràng không phải secret trong `key=value`: giá trị giữ chỗ
/// (`${VAR}`, `$VAR`, `<...>`, `%VAR%`, `(...)`), boolean/null, chuỗi toàn `*`/`x`.
fn is_plausible_assigned_secret(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let placeholder = value.starts_with('$')
        || value.starts_with('<')
        || value.starts_with('%')
        || value.starts_with('(')
        || value.chars().all(|c| c == '*' || c == 'x' || c == 'X');
    let keyword = matches!(
        lower.as_str(),
        "true" | "false" | "null" | "none" | "nil" | "undefined" | "required" | "optional"
    );
    !placeholder && !keyword
}

/// Các rule có sẵn, theo thứ tự ưu tiên (cụ thể trước, chung sau).
///
/// | `kind` | Ví dụ dạng |
/// | --- | --- |
/// | `private_key` | khối PEM `-----BEGIN ... PRIVATE KEY-----` (kể cả bị cắt mất dòng END) |
/// | `jwt` | `eyJ...`.`eyJ...`.`...` |
/// | `aws_access_key` | `AKIA` + 16 ký tự |
/// | `github_token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` |
/// | `anthropic_api_key` | `sk-ant-...` |
/// | `openai_api_key` | `sk-...`, `sk-proj-...` (≥ 32 ký tự sau tiền tố) |
/// | `stripe_key` | `sk_live_`, `sk_test_`, `rk_live_`, `rk_test_` |
/// | `slack_token` | `xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`, `xoxs-`, `xoxo-` |
/// | `slack_webhook` | `https://hooks.slack.com/services/T.../B.../...` |
/// | `google_api_key` | `AIza` + 35 ký tự |
/// | `basic_auth` | `Authorization: Basic <base64>` (chỉ che phần base64) |
/// | `bearer_token` | `Bearer <token>` (chỉ che token) |
/// | `url_password` | `scheme://user:pass@host` (chỉ che mật khẩu) |
/// | `secret_assignment` | `PASSWORD=...`, `api_key: "..."`, `"client_secret": "..."` (chỉ che giá trị) |
pub fn builtin_rules() -> Vec<Rule> {
    const RULES: &[(&str, &str)] = &[
        (
            "private_key",
            r"-----BEGIN[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?s:.*?-----END[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|.*)",
        ),
        (
            "jwt",
            r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
        ),
        ("aws_access_key", r"\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b"),
        (
            "github_token",
            r"\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b",
        ),
        ("anthropic_api_key", r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
        (
            "openai_api_key",
            r"\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}",
        ),
        ("stripe_key", r"\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}"),
        ("slack_token", r"\bxox[abposr]-[0-9A-Za-z-]{10,}"),
        (
            "slack_webhook",
            r"https://hooks\.slack\.com/(?:services|workflows)/[A-Za-z0-9_/]{20,}",
        ),
        ("google_api_key", r"\bAIza[0-9A-Za-z_-]{35}"),
        (
            "basic_auth",
            r"(?i)\bauthorization\s*[:=]\s*basic\s+(?P<secret>[A-Za-z0-9+/]{8,}={0,2})",
        ),
        (
            "bearer_token",
            r"(?i)\bbearer\s+(?P<secret>[A-Za-z0-9\-._~+/]{16,}=*)",
        ),
        (
            "url_password",
            r"\b[A-Za-z][A-Za-z0-9+.\-]*://[^\s:/@]+:(?P<secret>[^\s@/]+)@",
        ),
    ];

    let mut rules: Vec<Rule> = RULES
        .iter()
        .map(|&(kind, pattern)| builtin(kind, pattern))
        .collect();
    // Khóa phải KẾT THÚC bằng từ khóa (`DB_PASSWORD`, `api_key`), để `max_tokens=4096`
    // hay `secret_name: x` không bị che nhầm.
    rules.push(
        builtin(
            "secret_assignment",
            r#"(?i)\b[A-Za-z0-9_.\-]*?(?:password|passwd|pwd|secret|token|api_?key|apikey|access_?key|private_?key)["']?\s*[:=]\s*["']?(?P<secret>[^\s"'&;,]{4,})"#,
        )
        .with_filter(is_plausible_assigned_secret),
    );
    rules
}

fn builtin(kind: &str, pattern: &str) -> Rule {
    match Rule::new(kind, pattern) {
        Ok(rule) => rule,
        // Pattern có sẵn là hằng số, đã có test biên dịch; lỗi ở đây là lỗi lập trình.
        Err(err) => panic!("rule có sẵn không hợp lệ: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ghép chuỗi lúc chạy để mã nguồn không chứa token nguyên vẹn
    /// (tránh secret scanning báo nhầm). Mọi giá trị đều là dữ liệu giả.
    fn fake(parts: &[&str]) -> String {
        parts.concat()
    }

    fn redact(text: &str) -> Redacted {
        Redactor::shared().redact(text)
    }

    /// Che `secret` nằm giữa câu và kiểm tra nhãn + phần còn lại.
    fn assert_redacted(secret: &str, kind: &str) {
        let input = format!("trước {secret} sau");
        let out = redact(&input);
        assert_eq!(
            out.text,
            format!("trước [REDACTED:{kind}] sau"),
            "input: {input}"
        );
        assert_eq!(
            out.redactions,
            vec![RedactionCount {
                kind: kind.to_owned(),
                count: 1
            }]
        );
    }

    fn assert_untouched(text: &str) {
        let out = redact(text);
        assert_eq!(out.text, text);
        assert!(out.redactions.is_empty(), "che nhầm: {:?}", out.redactions);
    }

    #[test]
    fn builtin_rules_compile_and_have_unique_kinds() {
        let rules = builtin_rules();
        assert!(rules.len() >= 10);
        let mut kinds: Vec<&str> = rules.iter().map(Rule::kind).collect();
        kinds.sort_unstable();
        kinds.dedup();
        assert_eq!(kinds.len(), rules.len());
    }

    #[test]
    fn aws_access_key() {
        // Khóa ví dụ trong tài liệu AWS.
        assert_redacted(&fake(&["AKIA", "IOSFODNN7EXAMPLE"]), "aws_access_key");
        assert_redacted(&fake(&["ASIA", "ABCDEFGHIJ234567"]), "aws_access_key");
    }

    #[test]
    fn github_tokens() {
        let body36 = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
        for prefix in ["ghp_", "gho_", "ghs_", "ghu_", "ghr_"] {
            assert_redacted(&fake(&[prefix, body36]), "github_token");
        }
        assert_redacted(
            &fake(&[
                "github_pat_",
                "11ABCDEFG0123456789_abcdefghijKLMNOPQRSTUVwxyz0123456789",
            ]),
            "github_token",
        );
    }

    #[test]
    fn anthropic_and_openai_keys() {
        assert_redacted(
            &fake(&["sk-ant-", "api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_xyz"]),
            "anthropic_api_key",
        );
        assert_redacted(
            &fake(&["sk-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFGHIJKL"]),
            "openai_api_key",
        );
        assert_redacted(
            &fake(&[
                "sk-proj-",
                "AbCdEfGhIjKlMnOp_QrStUvWxYz-0123456789abcdefghij",
            ]),
            "openai_api_key",
        );
    }

    #[test]
    fn stripe_slack_google() {
        assert_redacted(
            &fake(&["sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"]),
            "stripe_key",
        );
        assert_redacted(
            &fake(&["rk_", "test_", "4eC39HqLyjWDarjtT1zdp7dc"]),
            "stripe_key",
        );
        assert_redacted(
            &fake(&[
                "xox",
                "b-",
                "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
            ]),
            "slack_token",
        );
        assert_redacted(
            &fake(&[
                "https://hooks.slack.com/",
                "services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
            ]),
            "slack_webhook",
        );
        assert_redacted(
            &fake(&["AIza", "SyA-1234567890abcdefghijklmnopqrstu"]),
            "google_api_key",
        );
    }

    #[test]
    fn private_key_block() {
        let pem = fake(&[
            "-----BEGIN ",
            "RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakefakefake\nabcdef==\n-----END RSA PRIVATE KEY-----",
        ]);
        assert_redacted(&pem, "private_key");

        let openssh = fake(&[
            "-----BEGIN ",
            "OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
        ]);
        assert_redacted(&openssh, "private_key");

        // Output bị cắt mất dòng END: che tới hết văn bản.
        let cut = fake(&["key:\n-----BEGIN ", "PRIVATE KEY-----\nMIIEvQIBADANfake\n…"]);
        assert_eq!(redact(&cut).text, "key:\n[REDACTED:private_key]");
    }

    #[test]
    fn jwt_token() {
        let jwt = fake(&[
            "eyJ",
            "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        ]);
        assert_redacted(&jwt, "jwt");
        // JWT trong header Bearer: nhãn theo rule cụ thể hơn (jwt).
        let out = redact(&format!("Authorization: Bearer {jwt}"));
        assert_eq!(out.text, "Authorization: Bearer [REDACTED:jwt]");
    }

    #[test]
    fn bearer_and_basic_headers() {
        let out = redact("curl -H \"Authorization: Bearer abcdefghijklmnop1234567890\" x");
        assert_eq!(
            out.text,
            "curl -H \"Authorization: Bearer [REDACTED:bearer_token]\" x"
        );
        let out = redact("authorization: basic dXNlcjpwYXNzd29yZA==");
        assert_eq!(out.text, "authorization: basic [REDACTED:basic_auth]");
    }

    #[test]
    fn url_password() {
        let out = redact("DATABASE_URL=postgres://teamlens:s3cr3t-pw@localhost:5433/db");
        // Cả khóa `..._URL` không kết thúc bằng từ khóa nên chỉ rule url_password khớp.
        assert_eq!(
            out.text,
            "DATABASE_URL=postgres://teamlens:[REDACTED:url_password]@localhost:5433/db"
        );
        let out = redact("git clone https://user:tok123@example.com/org/repo.git");
        assert_eq!(
            out.text,
            "git clone https://user:[REDACTED:url_password]@example.com/org/repo.git"
        );
    }

    #[test]
    fn secret_assignments() {
        for (input, expected) in [
            (
                "DB_PASSWORD=hunter22",
                "DB_PASSWORD=[REDACTED:secret_assignment]",
            ),
            (
                "password = \"abc123!\"",
                "password = \"[REDACTED:secret_assignment]\"",
            ),
            (
                "\"client_secret\": \"zzzz9999\"",
                "\"client_secret\": \"[REDACTED:secret_assignment]\"",
            ),
            (
                "API_KEY: qwertyuiop",
                "API_KEY: [REDACTED:secret_assignment]",
            ),
            (
                "GITHUB_TOKEN=abcd1234",
                "GITHUB_TOKEN=[REDACTED:secret_assignment]",
            ),
            (
                "https://x.io/cb?token=abcd1234&page=2",
                "https://x.io/cb?token=[REDACTED:secret_assignment]&page=2",
            ),
        ] {
            assert_eq!(redact(input).text, expected, "input: {input}");
        }
    }

    #[test]
    fn assignment_label_prefers_specific_rule() {
        let key = fake(&["sk-ant-", "api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123"]);
        let out = redact(&format!("ANTHROPIC_API_KEY={key}"));
        assert_eq!(out.text, "ANTHROPIC_API_KEY=[REDACTED:anthropic_api_key]");
        assert_eq!(out.redactions.len(), 1);
    }

    #[test]
    fn does_not_redact_lookalikes() {
        // Hash commit, UUID, số token của model, tên biến, placeholder.
        assert_untouched("commit 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39 đã merge");
        assert_untouched("id 123e4567-e89b-12d3-a456-426614174000");
        assert_untouched("max_tokens=4096, input_tokens: 1200");
        assert_untouched("secret_name: prod-db");
        assert_untouched("PASSWORD=${DB_PASSWORD}");
        assert_untouched("password: true");
        assert_untouched("let password = (input);");
        assert_untouched("http://localhost:3000/api/v1 và git@github.com:org/repo.git");
        assert_untouched("task-management-system-for-the-whole-company");
        assert_untouched("ghp_short và AKIA123");
        assert_untouched("Bearer token is required");
    }

    #[test]
    fn counts_multiple_kinds() {
        let aws = fake(&["AKIA", "IOSFODNN7EXAMPLE"]);
        let text = format!("{aws} {aws} PASSWORD=abcdefg");
        let out = redact(&text);
        assert_eq!(
            out.redactions,
            vec![
                RedactionCount {
                    kind: "aws_access_key".into(),
                    count: 2
                },
                RedactionCount {
                    kind: "secret_assignment".into(),
                    count: 1
                },
            ]
        );
    }

    #[test]
    fn redact_is_idempotent() {
        let text = fake(&[
            "token=abcd1234 AKIA",
            "IOSFODNN7EXAMPLE postgres://u:pw1234@h/db",
        ]);
        let once = redact(&text);
        let twice = redact(&once.text);
        assert_eq!(twice.text, once.text);
        assert!(twice.redactions.is_empty());
    }

    #[test]
    fn utf8_text_around_secret() {
        let out = redact("mật khẩu: PASSWORD=bíMật123 — xong 🎉");
        assert_eq!(
            out.text,
            "mật khẩu: PASSWORD=[REDACTED:secret_assignment] — xong 🎉"
        );
    }

    #[test]
    fn runtime_patterns() {
        let mut r = Redactor::builtin();
        r.add_pattern("internal_token", r"\bacme_[a-z0-9]{8}\b")
            .unwrap();
        let out = r.redact("dùng acme_ab12cd34 nhé");
        assert_eq!(out.text, "dùng [REDACTED:internal_token] nhé");

        r.add_pattern("employee_id", r"EMP-(?P<secret>\d{6})")
            .unwrap();
        assert_eq!(r.redact("EMP-123456").text, "EMP-[REDACTED:employee_id]");

        assert!(matches!(
            r.add_pattern("Bad-Kind", "x"),
            Err(RedactError::InvalidKind(_))
        ));
        assert!(matches!(
            r.add_pattern("ok_kind", "(unclosed"),
            Err(RedactError::InvalidPattern { .. })
        ));
    }

    #[test]
    fn merge_counts_sums_by_kind() {
        let a = vec![RedactionCount {
            kind: "jwt".into(),
            count: 1,
        }];
        let b = vec![
            RedactionCount {
                kind: "aws_access_key".into(),
                count: 2,
            },
            RedactionCount {
                kind: "jwt".into(),
                count: 3,
            },
        ];
        let merged = merge_counts([a.as_slice(), b.as_slice()]);
        assert_eq!(
            merged,
            vec![
                RedactionCount {
                    kind: "aws_access_key".into(),
                    count: 2
                },
                RedactionCount {
                    kind: "jwt".into(),
                    count: 4
                },
            ]
        );
    }

    #[test]
    fn empty_and_plain_text() {
        assert_untouched("");
        assert_untouched("Sửa lỗi đăng nhập trong src/auth.rs");
    }
}
