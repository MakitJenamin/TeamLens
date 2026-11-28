//! Đọc JSON từ stdin, kiểm tra pattern redaction, rồi in kết quả JSON ra stdout.
//!
//! Quy tắc sao chép từ `cli/crates/tl-core/src/redact.rs` (không phụ thuộc crate CLI để image API
//! không cần mã nguồn `cli/`). Sửa quy tắc che ở CLI thì sửa cả file này:
//! - biên dịch: `RegexBuilder` với `size_limit` = `REGEX_SIZE_LIMIT` (`Rule::new`);
//! - nhãn: `kind_from_id` (chữ thường, ký tự lạ thành `_`, bỏ `_` hai đầu, tối đa 64 ký tự);
//! - che: `Redactor::redact` (group `secret`, không tham gia thì che cả chuỗi khớp; bỏ khớp rỗng và
//!   chuỗi bắt đầu bằng `[REDACTED:`; gộp vùng chồng nhau, nhãn theo pattern đứng trước).
//!
//! Vào:  `{ "patterns": [{ "id": "...", "regex": "..." }], "sample": "..." }` (`sample` tùy chọn).
//! Ra:   `{ "ok": true, "matches": N, "redacted": "..." }` hoặc
//!       `{ "ok": false, "index": i, "id": "...", "reason": "invalid" | "too_broad", "error": "..." }`.
//! Không ghi log; `sample` và regex không bao giờ được in ra ngoài kết quả trên.

use std::io::{Read, Write};

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

/// Phải bằng `REGEX_SIZE_LIMIT` của CLI.
const REGEX_SIZE_LIMIT: usize = 2 << 20;
/// Tên capture group chỉ che một phần chuỗi khớp (giống CLI).
const SECRET_GROUP: &str = "secret";
/// Pattern che từ tỉ lệ này của bộ văn bản thường trở lên là quá rộng.
const MAX_COVERAGE: f64 = 0.2;
/// Trung bình cứ chừng này byte văn bản thường lại có một vùng bị che thì là quá rộng
/// (bắt pattern ngắn như `e`, `\s` che rải rác khắp nơi).
const MIN_BYTES_PER_MATCH: usize = 40;

/// Văn bản thường (prompt, code, log, diff, JSON, đường dẫn) không chứa secret. Pattern che phần
/// lớn bộ này (`.+`, `\w+`, `[\s\S]*`...) sẽ che trắng nội dung mọi session.
const NORMAL_TEXTS: &[&str] = &[
    "Sửa giúp mình lỗi đăng nhập: khi bấm nút Đăng nhập thì trang chỉ quay vòng mãi, không báo lỗi gì. \
     Mình nghĩ do hàm refreshToken trả về undefined khi phiên hết hạn. Đọc file src/auth/session.ts rồi \
     đề xuất cách sửa, nhớ thêm test cho trường hợp hết hạn nhé.",
    "Please refactor the user list component so it paginates on the server instead of loading every \
     row at once. Keep the current filters working and update the README section about the API.",
    "fn parse_line(line: &str) -> Option<(String, u32)> {\n    let (name, count) = line.split_once(',')?;\n    \
     Some((name.trim().to_owned(), count.trim().parse().ok()?))\n}\n",
    "export async function listProjects(db: Database, userId: string) {\n  const rows = await db.select().from(projects)\
     .where(eq(projects.ownerId, userId));\n  return rows.map((row) => ({ id: row.id, name: row.name }));\n}\n",
    "running 12 tests\ntest scope::tests::matches_remote ... ok\ntest redact::tests::keeps_paths ... ok\n\
     test result: ok. 12 passed; 0 failed; 0 ignored; finished in 0.42s\n",
    "diff --git a/apps/web/src/app/page.tsx b/apps/web/src/app/page.tsx\n@@ -10,7 +10,8 @@ export default function Page() {\n\
     -  return <main className=\"p-4\">{children}</main>;\n+  const t = useTranslations(\"home\");\n\
     +  return <main className=\"p-6\">{t(\"title\")}</main>;\n",
    "{\"name\": \"teamlens-web\", \"version\": \"0.4.0\", \"private\": true, \"scripts\": {\"dev\": \"next dev\", \
     \"build\": \"next build\", \"lint\": \"oxlint src/\"}}",
    "C:\\Projects\\demo\\src\\main.rs:42:9: warning: unused variable `count`\n\
     PS C:\\Projects\\demo> cargo clippy --all-targets -- -D warnings\n    Checking demo v0.1.0\n",
    "Đã chạy pnpm test, 3 test fail ở module báo cáo tuần vì múi giờ. Tuần bắt đầu thứ Hai theo giờ Việt Nam, \
     không phải UTC; sửa lại hàm startOfWeek và chạy lại toàn bộ test.",
];

#[derive(Deserialize)]
struct Input {
    patterns: Vec<Pattern>,
    sample: Option<String>,
}

#[derive(Deserialize)]
struct Pattern {
    id: String,
    regex: String,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Output {
    Ok {
        ok: bool,
        matches: usize,
        redacted: Option<String>,
    },
    Err {
        ok: bool,
        index: usize,
        id: String,
        reason: &'static str,
        error: String,
    },
}

impl Output {
    fn err(index: usize, id: &str, reason: &'static str, error: String) -> Self {
        Output::Err {
            ok: false,
            index,
            id: id.to_owned(),
            reason,
            error,
        }
    }
}

/// Như `Rule::new` của CLI (phần biên dịch).
fn build(pattern: &str) -> Result<Regex, regex::Error> {
    RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
}

/// Sao chép `kind_from_id` của CLI: nhãn trong `[REDACTED:<kind>]`; `None` thì CLI bỏ pattern.
fn kind_from_id(id: &str) -> Option<String> {
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

/// Các vùng một pattern che trong `text`, theo vòng lặp của `Redactor::redact` ở CLI.
fn spans(regex: &Regex, text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    for caps in regex.captures_iter(text) {
        let Some(m) = caps.name(SECRET_GROUP).or_else(|| caps.get(0)) else {
            continue;
        };
        if m.is_empty() || m.as_str().starts_with("[REDACTED:") {
            continue;
        }
        out.push((m.start(), m.end()));
    }
    out
}

/// Gộp vùng chồng nhau như CLI; phần tử là `(start, end, chỉ số pattern)`, nhãn theo chỉ số nhỏ nhất.
fn merge(mut all: Vec<(usize, usize, usize)>) -> Vec<(usize, usize, usize)> {
    all.sort_unstable();
    let mut merged: Vec<(usize, usize, usize)> = Vec::with_capacity(all.len());
    for (start, end, idx) in all {
        match merged.last_mut() {
            Some(last) if start < last.1 => {
                last.1 = last.1.max(end);
                last.2 = last.2.min(idx);
            }
            _ => merged.push((start, end, idx)),
        }
    }
    merged
}

/// Che `text` bằng mọi pattern cùng lúc như CLI; trả văn bản đã che và số vùng che.
fn redact(rules: &[(String, Regex)], text: &str) -> (String, usize) {
    let mut all = Vec::new();
    for (idx, (_, re)) in rules.iter().enumerate() {
        all.extend(spans(re, text).into_iter().map(|(s, e)| (s, e, idx)));
    }
    let merged = merge(all);
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    for &(start, end, idx) in &merged {
        out.push_str(&text[pos..start]);
        out.push_str("[REDACTED:");
        out.push_str(&rules[idx].0);
        out.push(']');
        pos = end;
    }
    out.push_str(&text[pos..]);
    (out, merged.len())
}

/// Tỉ lệ byte bị che trên bộ văn bản thường nếu `Some`, khi pattern quá rộng.
fn too_broad(regex: &Regex) -> Option<f64> {
    let (mut total, mut covered, mut count) = (0usize, 0usize, 0usize);
    for text in NORMAL_TEXTS {
        let found = spans(regex, text);
        let merged = merge(found.into_iter().map(|(s, e)| (s, e, 0)).collect());
        total += text.len();
        count += merged.len();
        covered += merged.iter().map(|(s, e, _)| e - s).sum::<usize>();
    }
    let coverage = covered as f64 / total as f64;
    (coverage >= MAX_COVERAGE || count * MIN_BYTES_PER_MATCH >= total).then_some(coverage)
}

fn run(input: Input) -> Output {
    let mut rules = Vec::with_capacity(input.patterns.len());
    for (index, p) in input.patterns.iter().enumerate() {
        let Some(kind) = kind_from_id(&p.id) else {
            return Output::err(index, &p.id, "invalid", "id không có chữ hoặc số".into());
        };
        let re = match build(&p.regex) {
            Ok(re) => re,
            Err(e) => return Output::err(index, &p.id, "invalid", e.to_string()),
        };
        if let Some(coverage) = too_broad(&re) {
            return Output::err(
                index,
                &p.id,
                "too_broad",
                format!("che {:.0}% văn bản thường", (coverage * 100.0).max(1.0)),
            );
        }
        rules.push((kind, re));
    }
    let Some(sample) = input.sample else {
        return Output::Ok {
            ok: true,
            matches: 0,
            redacted: None,
        };
    };
    let (redacted, matches) = redact(&rules, &sample);
    Output::Ok {
        ok: true,
        matches,
        redacted: Some(redacted),
    }
}

fn main() {
    let mut raw = String::new();
    let output = match std::io::stdin().read_to_string(&mut raw) {
        Ok(_) => match serde_json::from_str::<Input>(&raw) {
            Ok(input) => run(input),
            Err(e) => Output::err(0, "", "invalid", format!("đầu vào không hợp lệ: {e}")),
        },
        Err(e) => Output::err(0, "", "invalid", format!("không đọc được stdin: {e}")),
    };
    let _ = writeln!(
        std::io::stdout(),
        "{}",
        serde_json::to_string(&output).unwrap_or_else(|_| "{\"ok\":false}".into())
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(patterns: &[(&str, &str)], sample: Option<&str>) -> Input {
        Input {
            patterns: patterns
                .iter()
                .map(|(id, regex)| Pattern {
                    id: (*id).into(),
                    regex: (*regex).into(),
                })
                .collect(),
            sample: sample.map(Into::into),
        }
    }

    fn json(o: &Output) -> String {
        serde_json::to_string(o).unwrap()
    }

    #[test]
    fn che_ca_chuoi_khop() {
        let out = json(&run(input(&[("acme", r"ACME-\d+")], Some("a ACME-12 b"))));
        assert!(out.contains("\"matches\":1"));
        assert!(out.contains("a [REDACTED:acme] b"));
    }

    #[test]
    fn group_secret_chi_che_mot_phan() {
        let out = json(&run(input(
            &[("pw", r"pw=(?P<secret>\w+)")],
            Some("pw=abc"),
        )));
        assert!(out.contains("pw=[REDACTED:pw]"));
    }

    #[test]
    fn group_secret_khong_tham_gia_thi_che_ca_chuoi() {
        // Giống CLI: `caps.name("secret").or_else(|| caps.get(0))`.
        let out = json(&run(input(
            &[("k", r"KEY-(?P<secret>\d+)|TOKEN-[A-Z]+")],
            Some("KEY-12 TOKEN-AB"),
        )));
        assert!(out.contains("KEY-[REDACTED:k] [REDACTED:k]"), "{out}");
        assert!(out.contains("\"matches\":2"));
    }

    #[test]
    fn bo_khop_rong() {
        let out = json(&run(input(&[("d", r"\d*")], Some("ab 12 cd"))));
        assert!(out.contains("ab [REDACTED:d] cd"), "{out}");
        assert!(out.contains("\"matches\":1"));
    }

    #[test]
    fn nhieu_pattern_gop_vung_chong_nhau_nhan_theo_pattern_truoc() {
        let out = json(&run(input(
            &[("a", r"AB\d+"), ("b", r"\d+CD")],
            Some("x AB12CD y"),
        )));
        assert!(out.contains("x [REDACTED:a] y"), "{out}");
        assert!(out.contains("\"matches\":1"));
    }

    #[test]
    fn khong_che_lai_marker() {
        let out = json(&run(input(
            &[("m", r"\[REDACTED:\w+\]")],
            Some("[REDACTED:x]"),
        )));
        assert!(out.contains("\"matches\":0"), "{out}");
    }

    #[test]
    fn nhan_theo_kind_from_id_cua_cli() {
        assert_eq!(kind_from_id("_").as_deref(), None);
        assert_eq!(kind_from_id("_acme_").as_deref(), Some("acme"));
        let out = json(&run(input(&[("_", "x")], None)));
        assert!(out.contains("\"reason\":\"invalid\""), "{out}");
    }

    #[test]
    fn tu_choi_pattern_qua_rong() {
        for re in [
            ".+",
            ".*",
            r"[\s\S]+",
            r"(?s).*",
            r"\w+",
            r"\S+",
            r"[a-z]+",
            "e",
            r"\s",
            ".",
            r"(?P<secret>.+)",
            r"\b\w{3,}\b",
        ] {
            let out = json(&run(input(&[("x", re)], None)));
            assert!(out.contains("\"reason\":\"too_broad\""), "{re}: {out}");
        }
    }

    #[test]
    fn nhan_pattern_binh_thuong() {
        for re in [
            r"ACME-\d+",
            r"\bacme_[a-z0-9]{8}\b",
            r"EMP-(?P<secret>\d{6})",
            r"(?i)password\s*=\s*(?P<secret>\S+)",
            r"\b[A-F0-9]{32}\b",
            r"tok_[A-Za-z0-9]{20,}",
            r"\d{4,}",
        ] {
            let out = json(&run(input(&[("x", re)], None)));
            assert!(out.contains("\"ok\":true"), "{re}: {out}");
        }
    }

    #[test]
    fn tu_choi_lookaround_cua_node() {
        let out = json(&run(input(&[("ok", r"ok_\d+"), ("bad", r"(?<=a)b")], None)));
        assert!(out.contains("\"ok\":false"));
        assert!(out.contains("\"index\":1"));
        assert!(out.contains("\"reason\":\"invalid\""));
    }

    #[test]
    fn tu_choi_backreference() {
        let out = json(&run(input(&[("bad", r"(a)\1")], None)));
        assert!(out.contains("\"ok\":false"));
    }

    #[test]
    fn tu_choi_regex_qua_lon() {
        let out = json(&run(input(&[("big", r"[a-z]{1000}{1000}")], None)));
        assert!(out.contains("\"ok\":false"));
    }
}
