//! Che secret trước khi gửi (spec mục 6.2) — task M1.5 (cơ bản), M2.1 (đầy đủ).
//!
//! Mỗi loại secret là một [`Rule`] có tên (`kind`, dạng `^[a-z0-9_]+$`, khớp
//! `Redaction.type` trong schema session v1) và một regex. [`Redactor`] chạy mọi
//! rule trên văn bản gốc, gộp các vùng trùng nhau rồi thay mỗi vùng bằng
//! `[REDACTED:<kind>]`, đồng thời đếm số lần che theo loại.
//!
//! Bộ rule có sẵn ([`builtin_rules`], M2.1) theo gitleaks: hơn 40 loại khóa có tiền tố
//! riêng của dịch vụ, cộng các rule theo ngữ cảnh (`url_password`, `secret_assignment`,
//! `high_entropy_secret` kiểm tra entropy sau từ khóa). Pattern leader cấu hình trên
//! server (`redaction_patterns` của `GET /agent/v1/config`) nạp bằng
//! [`Redactor::with_external`]: pattern lỗi bị bỏ qua, rule có sẵn vẫn giữ nguyên.
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

use regex::{Regex, RegexBuilder};

/// Giới hạn kích thước regex đã biên dịch (chặn pattern từ server quá nặng).
const REGEX_SIZE_LIMIT: usize = 2 << 20;

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
        let regex = RegexBuilder::new(pattern)
            .size_limit(REGEX_SIZE_LIMIT)
            .build()
            .map_err(|source| RedactError::InvalidPattern {
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

/// Chuẩn hóa id pattern (từ server) thành tên loại hợp lệ `^[a-z0-9_]+$`: chữ thường,
/// ký tự khác thành `_`, bỏ `_` thừa ở hai đầu. `None` nếu không còn ký tự nào.
///
/// ```
/// use tl_core::redact::kind_from_id;
/// assert_eq!(kind_from_id("Acme-Internal Token").as_deref(), Some("acme_internal_token"));
/// assert_eq!(kind_from_id("--"), None);
/// ```
pub fn kind_from_id(id: &str) -> Option<String> {
    let mapped: String = id
        .trim()
        .chars()
        .map(|c| {
            let c = c.to_ascii_lowercase();
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                c
            } else {
                '_'
            }
        })
        .collect();
    let kind = mapped.trim_matches('_');
    (!kind.is_empty()).then(|| kind.chars().take(64).collect())
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

    /// Bộ che gồm rule có sẵn + pattern nạp từ bên ngoài (`(id, regex)`, ví dụ
    /// `redaction_patterns` của `GET /agent/v1/config`).
    ///
    /// - `id` được chuẩn hóa thành tên loại ([`kind_from_id`]) và hiện trong
    ///   `[REDACTED:<id>]`.
    /// - Pattern ngoài được chèn ngay trước nhóm rule chung ([`GENERIC_KINDS`]): khi
    ///   trùng vùng với `secret_assignment`... thì nhãn của pattern ngoài thắng, còn rule
    ///   có tiền tố riêng (khóa AWS, GitHub...) vẫn ưu tiên hơn.
    /// - Pattern lỗi (id rỗng, regex sai, quá nặng) bị bỏ qua và trả về trong danh sách
    ///   lỗi để nơi gọi cảnh báo; không bao giờ panic hay mất rule có sẵn.
    pub fn with_external<'a, I>(patterns: I) -> (Self, Vec<RedactError>)
    where
        I: IntoIterator<Item = (&'a str, &'a str)>,
    {
        let mut rules = builtin_rules();
        let mut at = rules
            .iter()
            .position(|r| GENERIC_KINDS.contains(&r.kind()))
            .unwrap_or(rules.len());
        let mut errors = Vec::new();
        for (id, pattern) in patterns {
            let rule = kind_from_id(id)
                .ok_or_else(|| RedactError::InvalidKind(id.to_owned()))
                .and_then(|kind| Rule::new(kind, pattern));
            match rule {
                Ok(rule) => {
                    rules.insert(at, rule);
                    at += 1;
                }
                Err(err) => errors.push(err),
            }
        }
        (Self { rules }, errors)
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
        || value.starts_with("{{")
        || value.chars().all(|c| c == '*' || c == 'x' || c == 'X');
    let keyword = matches!(
        lower.as_str(),
        "true" | "false" | "null" | "none" | "nil" | "undefined" | "required" | "optional"
    );
    !placeholder && !keyword
}

/// Shannon entropy (bit/ký tự) của chuỗi.
pub fn shannon_entropy(s: &str) -> f64 {
    let mut freq: BTreeMap<char, u32> = BTreeMap::new();
    let mut total = 0u32;
    for c in s.chars() {
        *freq.entry(c).or_default() += 1;
        total += 1;
    }
    if total == 0 {
        return 0.0;
    }
    let total = f64::from(total);
    freq.values()
        .map(|&n| {
            let p = f64::from(n) / total;
            -p * p.log2()
        })
        .sum()
}

/// Ngưỡng entropy tối thiểu của rule `high_entropy_secret`.
pub const ENTROPY_THRESHOLD: f64 = 3.5;

/// `8-4-4-4-12` hex.
fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Bộ lọc của rule `high_entropy_secret`: chuỗi đứng sau từ khóa chỉ bị che khi
/// trông như ngẫu nhiên. Loại hash commit/SHA-256 (40/64 hex), UUID, đường dẫn,
/// URL, tên định danh (`com.example.app`, `v2-build-linux-x64`, `camelCaseName`).
pub fn is_high_entropy_secret(value: &str) -> bool {
    let len = value.chars().count();
    if len < 20 || !is_plausible_assigned_secret(value) || is_uuid(value) {
        return false;
    }
    if (len == 40 || len == 64) && value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let path_like = value.starts_with(['/', '.', '~'])
        || value.contains('\\')
        || value.contains("://")
        || value.as_bytes().get(1) == Some(&b':');
    if path_like {
        return false;
    }
    // Cần chữ + số, hoặc cả chữ hoa lẫn thường.
    let has_digit = value.bytes().any(|b| b.is_ascii_digit());
    let has_upper = value.bytes().any(|b| b.is_ascii_uppercase());
    let has_lower = value.bytes().any(|b| b.is_ascii_lowercase());
    if !((has_digit && (has_upper || has_lower)) || (has_upper && has_lower)) {
        return false;
    }
    // Tên định danh nhiều đoạn: ≥ 3 đoạn và ≥ 2 đoạn là chữ thuần (≥ 3 ký tự).
    let segments: Vec<&str> = value
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    let word_segments = segments
        .iter()
        .filter(|s| s.len() >= 3 && s.bytes().all(|b| b.is_ascii_alphabetic()))
        .count();
    if segments.len() >= 3 && word_segments >= 2 {
        return false;
    }
    // camelCase: ≥ 75% ký tự nằm trong các "từ" (chuỗi chữ thường dài ≥ 4, nguyên âm
    // ≥ 30%); chuỗi chữ thường ngẫu nhiên ít nguyên âm nên không bị loại.
    let mut in_words = 0usize;
    let (mut run, mut vowels) = (0usize, 0usize);
    for c in value.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_lowercase() {
            run += 1;
            vowels += usize::from(matches!(c, 'a' | 'e' | 'i' | 'o' | 'u' | 'y'));
        } else {
            if run >= 4 && vowels * 10 >= run * 3 {
                in_words += run;
            }
            (run, vowels) = (0, 0);
        }
    }
    if in_words * 4 >= len * 3 {
        return false;
    }
    // Chuỗi ngẫu nhiên đổi lớp ký tự (hoa/thường/số/khác) thường xuyên; camelCase thì hiếm.
    let class = |c: char| match c {
        'A'..='Z' => 0u8,
        'a'..='z' => 1,
        '0'..='9' => 2,
        _ => 3,
    };
    let chars: Vec<char> = value.chars().collect();
    let transitions = chars
        .windows(2)
        .filter(|w| class(w[0]) != class(w[1]))
        .count();
    transitions * 5 >= len && shannon_entropy(value) >= ENTROPY_THRESHOLD
}

/// Token Discord: đoạn đầu (ID người dùng mã hóa base64) có chữ số, có cả hoa và
/// thường, để không nhầm với `Namespace.method.identifier` dài.
fn is_plausible_discord_token(value: &str) -> bool {
    let first = value.split('.').next().unwrap_or("");
    first.bytes().any(|b| b.is_ascii_digit())
        && value.bytes().any(|b| b.is_ascii_uppercase())
        && value.bytes().any(|b| b.is_ascii_lowercase())
}

/// Các loại "chung" (dựa vào từ khóa/ngữ cảnh, không phải tiền tố riêng của dịch vụ).
/// Pattern nạp từ server được chèn ngay trước nhóm này để nhãn của nó được ưu tiên.
pub const GENERIC_KINDS: &[&str] = &[
    "basic_auth",
    "bearer_token",
    "url_password",
    "secret_assignment",
    "high_entropy_secret",
];

/// Bảng rule có sẵn: `(kind, pattern, bộ lọc)`, theo thứ tự ưu tiên.
type RuleSpec = (&'static str, &'static str, Option<fn(&str) -> bool>);

/// Các rule có sẵn, theo thứ tự ưu tiên (cụ thể trước, chung sau), dựa trên bộ
/// rule của gitleaks. Tên loại (`kind`) là ổn định: server hiển thị và thống kê theo nó.
///
/// | `kind` | Ví dụ dạng |
/// | --- | --- |
/// | `private_key` | khối PEM `-----BEGIN ... PRIVATE KEY-----` (kể cả bị cắt mất dòng END) |
/// | `gcp_service_account` | `"private_key_id": "<40 hex>"` trong file JSON service account |
/// | `age_secret_key` | `AGE-SECRET-KEY-1...` |
/// | `jwt` | `eyJ...`.`eyJ...`.`...` |
/// | `aws_access_key` | `AKIA`/`ASIA`... + 16 ký tự |
/// | `aws_secret_key` | `aws_secret_access_key = <40 ký tự>` (chỉ che giá trị) |
/// | `github_token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` |
/// | `gitlab_pat` | `glpat-...` |
/// | `gitlab_pipeline_token` | `glptt-<40 hex>` |
/// | `gitlab_runner_token` | `GR1348941...`, `glrt-...` |
/// | `gitlab_token` | `gldt-`, `glft-`, `glsoat-`, `glcbt-`, `glimt-`, `glagent-`... |
/// | `anthropic_api_key` | `sk-ant-...` |
/// | `openai_api_key` | `sk-...`, `sk-proj-...`, `sk-svcacct-...` (≥ 32 ký tự sau tiền tố) |
/// | `stripe_key` | `sk_live_`, `sk_test_`, `rk_live_`, `rk_test_`, `whsec_` |
/// | `slack_token` | `xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`, `xoxs-`, `xoxo-`, `xoxe-`, `xapp-` |
/// | `slack_webhook` | `https://hooks.slack.com/services/T.../B.../...` |
/// | `discord_webhook` | `https://discord.com/api/webhooks/<id>/<token>` |
/// | `discord_bot_token` | `M.../N.../O...` `.` 6 ký tự `.` 27–38 ký tự |
/// | `telegram_bot_token` | `<8–10 số>:AA<33 ký tự>` |
/// | `twilio_api_key` | `SK` + 32 hex |
/// | `sendgrid_api_key` | `SG.<22>.<43>` |
/// | `mailgun_api_key` | `key-` + 32 hex |
/// | `npm_token` | `npm_` + 36 ký tự |
/// | `pypi_token` | `pypi-AgEIcHlwaS5vcmc...` |
/// | `dockerhub_token` | `dckr_pat_...` |
/// | `google_api_key` | `AIza` + 35 ký tự |
/// | `google_oauth_client_secret` | `GOCSPX-` + 28 ký tự |
/// | `azure_storage_key` | `AccountKey=<88 ký tự base64>` (chỉ che khóa) |
/// | `azure_connection_string` | `SharedAccessKey=...`, `SharedAccessSignature=...` (chỉ che giá trị) |
/// | `azure_sas_token` | `?sv=...&sig=<chữ ký>` (chỉ che chữ ký) |
/// | `azure_ad_client_secret` | `abc8Q~...` |
/// | `heroku_api_key` | `HRKU-...`, `HEROKU_API_KEY=<uuid>` |
/// | `digitalocean_token` | `dop_v1_`, `doo_v1_`, `dor_v1_` + 64 hex |
/// | `shopify_token` | `shpat_`, `shpca_`, `shppa_`, `shpss_` + 32 hex |
/// | `huggingface_token` | `hf_...` |
/// | `databricks_token` | `dapi` + 32 hex |
/// | `linear_api_key` | `lin_api_...` |
/// | `hashicorp_vault_token` | `hvs.`, `hvb.` |
/// | `postman_api_key` | `PMAK-<24 hex>-<34 hex>` |
/// | `new_relic_key` | `NRAK-...` |
/// | `sentry_token` | `sntrys_`, `sntryu_` |
/// | `doppler_token` | `dp.pt.`, `dp.st.`... |
/// | `grafana_token` | `glsa_...`, `glc_...` |
/// | `basic_auth` | `Authorization: Basic <base64>` (chỉ che phần base64) |
/// | `bearer_token` | `Bearer <token>` (chỉ che token) |
/// | `url_password` | connection string `scheme://user:pass@host` (`postgres://`, `mongodb+srv://`...; chỉ che mật khẩu) |
/// | `secret_assignment` | `PASSWORD=...`, `api_key: "..."`, `"client_secret": "..."`, `?token=...` (chỉ che giá trị) |
/// | `high_entropy_secret` | chuỗi ≥ 20 ký tự entropy cao ngay sau `key`, `auth`, `credential`... (chỉ che giá trị) |
pub fn builtin_rules() -> Vec<Rule> {
    const RULES: &[RuleSpec] = &[
        (
            "private_key",
            r"-----BEGIN[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?s:.*?-----END[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|.*)",
            None,
        ),
        (
            "gcp_service_account",
            r#""private_key_id"\s*:\s*"(?P<secret>[0-9a-f]{40})""#,
            None,
        ),
        (
            "age_secret_key",
            r"\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}\b",
            None,
        ),
        (
            "jwt",
            r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
            None,
        ),
        (
            "aws_access_key",
            r"\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[0-9A-Z]{16}\b",
            None,
        ),
        (
            "aws_secret_key",
            r#"(?i)\baws_?(?:secret_?(?:access_?)?key|secret)["']?\s*[:=]\s*["']?(?P<secret>[A-Za-z0-9/+]{40})(?:[^A-Za-z0-9/+=]|$)"#,
            None,
        ),
        (
            "github_token",
            r"\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b",
            None,
        ),
        ("gitlab_pat", r"\bglpat-[A-Za-z0-9_-]{20,}", None),
        ("gitlab_pipeline_token", r"\bglptt-[0-9a-f]{40}\b", None),
        (
            "gitlab_runner_token",
            r"\b(?:GR1348941[A-Za-z0-9_-]{20,}|glrt-[A-Za-z0-9_-]{20,})",
            None,
        ),
        (
            "gitlab_token",
            r"\bgl(?:dt|ft|soat|cbt|imt|agent|oas|wt)-[A-Za-z0-9_-]{20,}",
            None,
        ),
        ("anthropic_api_key", r"\bsk-ant-[A-Za-z0-9_-]{20,}", None),
        (
            "openai_api_key",
            r"\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}",
            None,
        ),
        (
            "stripe_key",
            r"\b(?:(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}|whsec_[0-9A-Za-z]{32,})",
            None,
        ),
        (
            "slack_token",
            r"\b(?:xox[abposre]-[0-9A-Za-z-]{10,}|xapp-\d-[A-Z0-9]+-\d+-[A-Za-z0-9]+)",
            None,
        ),
        (
            "slack_webhook",
            r"https://hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9_/]{20,}",
            None,
        ),
        (
            "discord_webhook",
            r"https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9_-]{30,}",
            None,
        ),
        (
            "discord_bot_token",
            r"\b[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}",
            Some(is_plausible_discord_token),
        ),
        (
            "telegram_bot_token",
            r"\b\d{8,10}:AA[0-9A-Za-z_-]{33}",
            None,
        ),
        ("twilio_api_key", r"\bSK[0-9a-fA-F]{32}\b", None),
        (
            "sendgrid_api_key",
            r"\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}",
            None,
        ),
        ("mailgun_api_key", r"\bkey-[0-9a-f]{32}\b", None),
        ("npm_token", r"\bnpm_[A-Za-z0-9]{36}\b", None),
        (
            "pypi_token",
            r"\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}",
            None,
        ),
        ("dockerhub_token", r"\bdckr_pat_[A-Za-z0-9_-]{27,}", None),
        ("google_api_key", r"\bAIza[0-9A-Za-z_-]{35}", None),
        (
            "google_oauth_client_secret",
            r"\bGOCSPX-[A-Za-z0-9_-]{28}",
            None,
        ),
        (
            "azure_storage_key",
            r"(?i)\bAccountKey\s*=\s*(?P<secret>[A-Za-z0-9+/]{86}==)",
            None,
        ),
        (
            "azure_connection_string",
            r#"(?i)\b(?:SharedAccessKey|SharedAccessSignature)\s*=\s*(?P<secret>[^;"'\s]{16,})"#,
            None,
        ),
        (
            "azure_sas_token",
            r"[?&]sig=(?P<secret>[A-Za-z0-9%+/=]{30,})",
            None,
        ),
        (
            "azure_ad_client_secret",
            r"(?:^|[^A-Za-z0-9_~.-])(?P<secret>[A-Za-z0-9_~.]{3}\dQ~[A-Za-z0-9_~.-]{31,34})(?:[^A-Za-z0-9_~.-]|$)",
            None,
        ),
        (
            "heroku_api_key",
            r#"\bHRKU-[A-Za-z0-9_-]{60}|(?i:heroku[a-z_ -]{0,20}(?:key|token|secret)["']?\s*[:=]\s*["']?(?P<secret>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))"#,
            None,
        ),
        ("digitalocean_token", r"\bdo[por]_v1_[a-f0-9]{64}\b", None),
        (
            "shopify_token",
            r"\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b",
            None,
        ),
        ("huggingface_token", r"\bhf_[A-Za-z0-9]{34,}\b", None),
        ("databricks_token", r"\bdapi[a-f0-9]{32}(?:-\d)?\b", None),
        ("linear_api_key", r"\blin_api_[A-Za-z0-9]{40}\b", None),
        (
            "hashicorp_vault_token",
            r"\bhv[sb]\.[A-Za-z0-9_-]{24,}",
            None,
        ),
        (
            "postman_api_key",
            r"\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\b",
            None,
        ),
        ("new_relic_key", r"\bNRAK-[A-Z0-9]{27}\b", None),
        (
            "sentry_token",
            r"\b(?:sntrys_[A-Za-z0-9+/=_]{40,}|sntryu_[a-f0-9]{64}\b)",
            None,
        ),
        (
            "doppler_token",
            r"\bdp\.(?:pt|st|sa|ct|scim|audit)\.[A-Za-z0-9]{40,}",
            None,
        ),
        (
            "grafana_token",
            r"\b(?:glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}\b|glc_[A-Za-z0-9+/]{32,}={0,2})",
            None,
        ),
        (
            "basic_auth",
            r"(?i)\bauthorization\s*[:=]\s*basic\s+(?P<secret>[A-Za-z0-9+/]{8,}={0,2})",
            None,
        ),
        (
            "bearer_token",
            r"(?i)\bbearer\s+(?P<secret>[A-Za-z0-9\-._~+/]{16,}=*)",
            None,
        ),
        (
            "url_password",
            r"\b[A-Za-z][A-Za-z0-9+.\-]*://[^\s:/@]+:(?P<secret>[^\s@/]+)@",
            None,
        ),
        // Khóa phải KẾT THÚC bằng từ khóa (`DB_PASSWORD`, `api_key`), để `max_tokens=4096`
        // hay `secret_name: x` không bị che nhầm.
        (
            "secret_assignment",
            r#"(?i)(?:password|passwd|pwd|secret|token|api_?key|apikey|access_?key|private_?key)["']?\s*[:=]\s*["']?(?P<secret>[^\s"'&;,]{4,})"#,
            Some(is_plausible_assigned_secret),
        ),
        // Từ khóa rộng hơn (`key`, `auth`, `credential`...) nhưng chỉ che chuỗi ≥ 20 ký tự
        // có entropy cao (spec 6.2).
        (
            "high_entropy_secret",
            r#"(?i)(?:key|secret|token|password|passwd|pwd|auth|credentials?|api_?key|access_?key)["']?\s*[:=]\s*["'`]?(?P<secret>[A-Za-z0-9+/=_\-.~]{20,})"#,
            Some(is_high_entropy_secret),
        ),
    ];

    RULES
        .iter()
        .map(|&(kind, pattern, filter)| {
            let rule = builtin(kind, pattern);
            match filter {
                Some(f) => rule.with_filter(f),
                None => rule,
            }
        })
        .collect()
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
        assert!(rules.len() >= 30, "chỉ có {} loại", rules.len());
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

    // ---------- Bộ mẫu M2.1: mỗi loại có sẵn ít nhất một secret giả ----------

    /// Sinh chuỗi giả xác định từ `seed` (LCG), chỉ gồm ký tự trong `alphabet`.
    fn gen(alphabet: &str, len: usize, seed: u64) -> String {
        let chars: Vec<char> = alphabet.chars().collect();
        let mut x = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        (0..len)
            .map(|_| {
                x = x
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                chars[((x >> 33) % chars.len() as u64) as usize]
            })
            .collect()
    }
    const B62: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    fn alnum(len: usize, seed: u64) -> String {
        gen(B62, len, seed)
    }
    fn hex(len: usize, seed: u64) -> String {
        gen("0123456789abcdef", len, seed)
    }
    fn upper(len: usize, seed: u64) -> String {
        gen("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", len, seed)
    }
    fn digits(len: usize, seed: u64) -> String {
        gen("123456789", len, seed)
    }

    /// Một mẫu: loại mong đợi, văn bản trước, secret (phải biến mất), văn bản sau.
    struct Sample {
        kind: &'static str,
        before: String,
        secret: String,
        after: String,
    }

    fn s(kind: &'static str, before: &str, secret: String, after: &str) -> Sample {
        Sample {
            kind,
            before: before.to_owned(),
            secret,
            after: after.to_owned(),
        }
    }

    /// Bộ mẫu ≥ 30 secret (mọi giá trị ghép lúc chạy, không phải khóa thật).
    fn samples() -> Vec<Sample> {
        vec![
            s(
                "private_key",
                "key file:\n",
                fake(&[
                    "-----BEGIN ",
                    "EC PRIVATE KEY-----\n",
                    &alnum(64, 1),
                    "\n-----END EC PRIVATE KEY-----",
                ]),
                "\nxong",
            ),
            s(
                "gcp_service_account",
                "{\"type\": \"service_account\", \"private_key_id\": \"",
                hex(40, 2),
                "\"}",
            ),
            s(
                "age_secret_key",
                "age: ",
                fake(&[
                    "AGE-SECRET-",
                    "KEY-1",
                    &gen("QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L", 58, 3),
                ]),
                " .",
            ),
            s(
                "jwt",
                "token ",
                fake(&["eyJ", &alnum(20, 4), ".eyJ", &alnum(30, 5), ".", &alnum(43, 6)]),
                " .",
            ),
            s("aws_access_key", "id ", fake(&["AKIA", &upper(16, 7)]), " ."),
            s(
                "aws_secret_key",
                "aws_secret_access_key = ",
                alnum(40, 8),
                "\nregion = x",
            ),
            s("github_token", "pat ", fake(&["ghp_", &alnum(36, 9)]), " ."),
            s("github_token", "oauth ", fake(&["gho_", &alnum(36, 10)]), " ."),
            s("github_token", "app ", fake(&["ghs_", &alnum(36, 11)]), " ."),
            s(
                "github_token",
                "fine ",
                fake(&["github_", "pat_", &alnum(22, 12), "_", &alnum(59, 13)]),
                " .",
            ),
            s("gitlab_pat", "gl ", fake(&["glpat-", &alnum(20, 14)]), " ."),
            s(
                "gitlab_pipeline_token",
                "trigger ",
                fake(&["glptt-", &hex(40, 15)]),
                " .",
            ),
            s(
                "gitlab_runner_token",
                "runner ",
                fake(&["glrt-", &alnum(20, 16)]),
                " .",
            ),
            s(
                "gitlab_runner_token",
                "reg ",
                fake(&["GR1348941", &alnum(20, 17)]),
                " .",
            ),
            s("gitlab_token", "deploy ", fake(&["gldt-", &alnum(20, 18)]), " ."),
            s(
                "anthropic_api_key",
                "k ",
                fake(&["sk-ant-", "api03-", &alnum(80, 19)]),
                " .",
            ),
            s(
                "openai_api_key",
                "k ",
                fake(&["sk-", "proj-", &alnum(48, 20)]),
                " .",
            ),
            s("openai_api_key", "k ", fake(&["sk-", &alnum(48, 21)]), " ."),
            s("stripe_key", "k ", fake(&["sk_", "live_", &alnum(24, 22)]), " ."),
            s("stripe_key", "wh ", fake(&["whsec_", &alnum(32, 23)]), " ."),
            s(
                "slack_token",
                "bot ",
                fake(&[
                    "xoxb-",
                    &digits(12, 24),
                    "-",
                    &digits(13, 25),
                    "-",
                    &alnum(24, 26),
                ]),
                " .",
            ),
            s(
                "slack_token",
                "user ",
                fake(&[
                    "xoxp-",
                    &digits(12, 27),
                    "-",
                    &digits(13, 28),
                    "-",
                    &alnum(24, 29),
                ]),
                " .",
            ),
            s(
                "slack_webhook",
                "hook ",
                fake(&[
                    "https://hooks.slack.com/",
                    "services/T",
                    &upper(8, 30),
                    "/B",
                    &upper(8, 31),
                    "/",
                    &alnum(24, 32),
                ]),
                " .",
            ),
            s(
                "discord_webhook",
                "hook ",
                fake(&[
                    "https://discord.com/api/",
                    "webhooks/",
                    &digits(18, 33),
                    "/",
                    &alnum(68, 34),
                ]),
                " .",
            ),
            s(
                "discord_bot_token",
                "bot ",
                fake(&["MTE0", &alnum(20, 35), ".", &alnum(6, 36), ".", &alnum(27, 37)]),
                " .",
            ),
            s(
                "telegram_bot_token",
                "tg ",
                fake(&[&digits(10, 38), ":AA", &alnum(33, 39)]),
                " .",
            ),
            s("twilio_api_key", "tw ", fake(&["SK", &hex(32, 40)]), " ."),
            s(
                "sendgrid_api_key",
                "sg ",
                fake(&["SG.", &alnum(22, 41), ".", &alnum(43, 42)]),
                " .",
            ),
            s("mailgun_api_key", "mg ", fake(&["key-", &hex(32, 43)]), " ."),
            s(
                "npm_token",
                "//registry.npmjs.org/:_authToken=",
                fake(&["npm_", &alnum(36, 44)]),
                "\n",
            ),
            s(
                "pypi_token",
                "pw ",
                fake(&["pypi-", "AgEIcHlwaS5vcmc", &alnum(60, 45)]),
                " .",
            ),
            s(
                "dockerhub_token",
                "docker login -p ",
                fake(&["dckr_", "pat_", &alnum(27, 46)]),
                " .",
            ),
            s("google_api_key", "g ", fake(&["AIza", &alnum(35, 47)]), " ."),
            s(
                "google_oauth_client_secret",
                "cs ",
                fake(&["GOCSPX-", &alnum(28, 48)]),
                " .",
            ),
            s(
                "azure_storage_key",
                "DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=",
                fake(&[&alnum(86, 49), "=="]),
                ";EndpointSuffix=core.windows.net",
            ),
            s(
                "azure_connection_string",
                "Endpoint=sb://acme.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccessKey=",
                alnum(44, 50),
                ";",
            ),
            s(
                "azure_sas_token",
                "https://acme.blob.core.windows.net/c/f.txt?sv=2022-11-02&ss=b&sig=",
                fake(&[&alnum(43, 51), "%3D"]),
                " .",
            ),
            s(
                "azure_ad_client_secret",
                "secret ",
                fake(&[&alnum(3, 52), "8Q~", &alnum(34, 53)]),
                " .",
            ),
            s("heroku_api_key", "h ", fake(&["HRKU-", &alnum(60, 54)]), " ."),
            s(
                "heroku_api_key",
                "HEROKU_API_KEY=",
                fake(&[
                    &hex(8, 55),
                    "-",
                    &hex(4, 56),
                    "-",
                    &hex(4, 57),
                    "-",
                    &hex(4, 58),
                    "-",
                    &hex(12, 59),
                ]),
                "\n",
            ),
            s(
                "digitalocean_token",
                "do ",
                fake(&["dop_", "v1_", &hex(64, 60)]),
                " .",
            ),
            s("shopify_token", "shop ", fake(&["shpat_", &hex(32, 61)]), " ."),
            s("huggingface_token", "hf ", fake(&["hf_", &alnum(34, 62)]), " ."),
            s("databricks_token", "db ", fake(&["dapi", &hex(32, 63)]), " ."),
            s(
                "linear_api_key",
                "lin ",
                fake(&["lin_", "api_", &alnum(40, 64)]),
                " .",
            ),
            s(
                "hashicorp_vault_token",
                "VAULT ",
                fake(&["hvs.", &alnum(90, 65)]),
                " .",
            ),
            s(
                "postman_api_key",
                "pm ",
                fake(&["PMAK-", &hex(24, 66), "-", &hex(34, 67)]),
                " .",
            ),
            s("new_relic_key", "nr ", fake(&["NRAK-", &upper(27, 68)]), " ."),
            s("sentry_token", "sentry ", fake(&["sntryu_", &hex(64, 69)]), " ."),
            s("doppler_token", "dp ", fake(&["dp.", "pt.", &alnum(43, 70)]), " ."),
            s(
                "grafana_token",
                "gf ",
                fake(&["glsa_", &alnum(32, 71), "_", &hex(8, 72)]),
                " .",
            ),
            s(
                "basic_auth",
                "Authorization: Basic ",
                fake(&[&alnum(30, 73), "=="]),
                "\n",
            ),
            s("bearer_token", "Authorization: Bearer ", alnum(40, 74), "\n"),
            s(
                "url_password",
                "DATABASE_URL=postgres://app:",
                alnum(16, 75),
                "@db.internal:5432/app",
            ),
            s(
                "url_password",
                "MONGO=mongodb+srv://admin:",
                alnum(16, 76),
                "@cluster0.mongodb.net/db",
            ),
            s("secret_assignment", "DB_PASSWORD=", alnum(12, 77), "\n"),
            s(
                "secret_assignment",
                "https://x.io/login?user=a&password=",
                alnum(12, 78),
                "&next=/",
            ),
            s(
                "secret_assignment",
                "export API_TOKEN=\"",
                alnum(24, 79),
                "\"\n",
            ),
            s("high_entropy_secret", "signing_key: ", alnum(32, 80), "\n"),
            s("high_entropy_secret", "\"auth\": \"", alnum(40, 81), "\""),
        ]
    }

    #[test]
    fn corpus_is_fully_redacted() {
        let samples = samples();
        assert!(samples.len() >= 30);
        for sample in &samples {
            let input = format!("{}{}{}", sample.before, sample.secret, sample.after);
            let out = redact(&input);
            assert!(
                !out.text.contains(&sample.secret),
                "lọt secret loại {}: {}",
                sample.kind,
                out.text
            );
            assert_eq!(
                out.redactions,
                vec![RedactionCount {
                    kind: sample.kind.to_owned(),
                    count: 1
                }],
                "sai loại cho mẫu {}: {}",
                sample.kind,
                out.text
            );
            assert!(
                out.text.contains(&format!("[REDACTED:{}]", sample.kind)),
                "{}",
                out.text
            );
        }
    }

    #[test]
    fn corpus_covers_every_builtin_kind() {
        let covered: std::collections::BTreeSet<&str> = samples().iter().map(|s| s.kind).collect();
        for rule in builtin_rules() {
            assert!(
                covered.contains(rule.kind()),
                "thiếu mẫu cho {}",
                rule.kind()
            );
        }
    }

    #[test]
    fn corpus_in_one_large_text() {
        // Tất cả mẫu trong cùng một văn bản (kiểu output dài): vẫn che đủ, đếm đúng.
        let samples = samples();
        let text: String = samples
            .iter()
            .map(|s| format!("{}{}{}\n", s.before, s.secret, s.after))
            .collect();
        let out = redact(&text);
        for sample in &samples {
            assert!(!out.text.contains(&sample.secret), "lọt {}", sample.kind);
        }
        let total: u32 = out.redactions.iter().map(|r| r.count).sum();
        assert_eq!(total as usize, samples.len());
    }

    /// Ghi bộ mẫu ra file JSON để tự test `tl preview` trên máy thật:
    /// `TL_DUMP_SAMPLES=<file> cargo test -p tl-core dump_samples -- --ignored`.
    #[test]
    #[ignore = "chỉ chạy tay khi tự test"]
    fn dump_samples() {
        let Ok(path) = std::env::var("TL_DUMP_SAMPLES") else {
            return;
        };
        let items: Vec<serde_json::Value> = samples()
            .iter()
            .map(|s| {
                serde_json::json!({
                    "kind": s.kind,
                    "secret": s.secret,
                    "text": format!("{}{}{}", s.before, s.secret, s.after),
                })
            })
            .collect();
        std::fs::write(path, serde_json::to_string_pretty(&items).unwrap()).unwrap();
    }

    #[test]
    fn entropy_filter() {
        assert!(shannon_entropy("aaaa") < 0.01);
        assert!(shannon_entropy(&alnum(40, 99)) > 4.5);
        assert!(is_high_entropy_secret(&alnum(24, 98)));
        for seed in 0..50 {
            let lower36 = gen("abcdefghijklmnopqrstuvwxyz0123456789", 32, 200 + seed);
            assert!(is_high_entropy_secret(&lower36), "{lower36}");
            let b62 = alnum(24, 300 + seed);
            assert!(is_high_entropy_secret(&b62), "{b62}");
        }
        // Không che: hash commit, SHA-256, UUID, đường dẫn, URL, tên định danh, chữ thuần.
        for v in [
            "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39".to_owned(),
            hex(64, 97),
            "123e4567-e89b-12d3-a456-426614174000".to_owned(),
            "src/components/AuthProviderModal.tsx".to_owned(),
            "./scripts/generate-keys-2024.sh".to_owned(),
            r"C:\repo\keys\dev2024.txt".to_owned(),
            "https://example.com/oauth2/callback".to_owned(),
            "com.example.mobile.app2024".to_owned(),
            "v2-build-2024-11-27-linux-x64".to_owned(),
            "authProviderConfigurationName1".to_owned(),
            "authProviderConfigurationName".to_owned(),
            "abcdefghijklmnopqrstuvwxyz".to_owned(),
            "${SIGNING_KEY_FROM_ENVIRONMENT}".to_owned(),
        ] {
            assert!(!is_high_entropy_secret(&v), "che nhầm: {v}");
        }
    }

    #[test]
    fn does_not_redact_code_and_hashes_after_keywords() {
        assert_untouched("cache_key: v2-build-2024-11-27-linux-x64");
        assert_untouched("key: 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39");
        assert_untouched("id_key = 123e4567-e89b-12d3-a456-426614174000");
        assert_untouched("key: src/components/AuthProviderModal.tsx");
        assert_untouched("authKey: authProviderConfigurationName");
        assert_untouched("public_key_path = ~/.ssh/id_rsa.pub");
        assert_untouched("<li key={item.id}>{item.name}</li>");
        assert_untouched("monkey: true, sort_key: createdAt");
        assert_untouched("const keyboardLayoutName = \"us-international-2024\";");
        assert_untouched(
            "sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
        assert_untouched("integrity: sha512-Q2xvdWQgYnVpbGQgY2FjaGU");
        assert_untouched("fn redact_token(token: &str) -> String { token.to_owned() }");
        assert_untouched("Skipping SKILL.md and Sketch files");
        assert_untouched("Mã lỗi key-not-found khi đọc cấu hình");
    }

    // ---------- Pattern nạp từ server ----------

    #[test]
    fn external_patterns_are_added_with_priority() {
        let (r, errors) = Redactor::with_external([
            ("acme_token", r"\bacme_[a-z0-9]{8}\b"),
            ("Employee ID", r"EMP-(?P<secret>\d{6})"),
        ]);
        assert!(errors.is_empty());
        assert_eq!(r.rules().len(), builtin_rules().len() + 2);
        assert_eq!(
            r.redact("dùng acme_ab12cd34 nhé").text,
            "dùng [REDACTED:acme_token] nhé"
        );
        assert_eq!(r.redact("EMP-123456").text, "EMP-[REDACTED:employee_id]");
        // Trùng vùng với rule chung: nhãn của pattern ngoài thắng.
        assert_eq!(
            r.redact("TOKEN=acme_ab12cd34").text,
            "TOKEN=[REDACTED:acme_token]"
        );
        // Rule có sẵn vẫn hoạt động.
        let aws = fake(&["AKIA", "IOSFODNN7EXAMPLE"]);
        assert_eq!(r.redact(&aws).text, "[REDACTED:aws_access_key]");
    }

    #[test]
    fn external_invalid_patterns_are_skipped() {
        let (r, errors) = Redactor::with_external([
            ("bad_regex", "(unclosed"),
            ("---", r"\bok\b"),
            ("too_big", r"\w{1000}\w{1000}\w{1000}"),
            ("good", r"\bhello_[0-9]{4}\b"),
        ]);
        assert_eq!(errors.len(), 3, "{errors:?}");
        assert_eq!(r.rules().len(), builtin_rules().len() + 1);
        assert_eq!(r.redact("hello_1234").text, "[REDACTED:good]");
        let aws = fake(&["AKIA", "IOSFODNN7EXAMPLE"]);
        assert_eq!(r.redact(&aws).text, "[REDACTED:aws_access_key]");
    }

    #[test]
    fn kind_from_id_normalizes() {
        assert_eq!(
            kind_from_id("internal_token").as_deref(),
            Some("internal_token")
        );
        assert_eq!(kind_from_id(" Acme Key ").as_deref(), Some("acme_key"));
        assert_eq!(kind_from_id("b7e1-ff").as_deref(), Some("b7e1_ff"));
        assert_eq!(kind_from_id(""), None);
        assert_eq!(kind_from_id("đ"), None);
    }

    #[test]
    fn large_session_timing() {
        // Khoảng 2 MB văn bản thường + rải secret: in thời gian để ghi vào PR (chạy
        // `cargo test --release -p tl-core large_session_timing -- --nocapture`).
        let line = "Sửa lỗi trong src/auth.rs: thêm kiểm tra token hết hạn, gọi api.refresh() rồi thử lại.\n";
        let mut text = line.repeat(20_000);
        for sample in samples() {
            text.push_str(&format!(
                "{}{}{}\n",
                sample.before, sample.secret, sample.after
            ));
        }
        let r = Redactor::builtin();
        let start = std::time::Instant::now();
        let out = r.redact(&text);
        let elapsed = start.elapsed();
        println!(
            "che {} KB, {} rule: {:?}",
            text.len() / 1024,
            r.rules().len(),
            elapsed
        );
        assert!(out.redactions.iter().map(|c| c.count).sum::<u32>() as usize >= 30);
    }
}
