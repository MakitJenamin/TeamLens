//! Đọc JSON từ stdin, kiểm tra pattern bằng `regex::RegexBuilder` với `size_limit` giống
//! `cli/crates/tl-core/src/redact.rs`, rồi in kết quả JSON ra stdout.
//!
//! Vào:  `{ "patterns": [{ "id": "...", "regex": "..." }], "sample": "..." }` (`sample` tùy chọn).
//! Ra:   `{ "ok": true, "matches": N, "redacted": "..." }` hoặc
//!       `{ "ok": false, "index": i, "id": "...", "error": "..." }`.
//! Không ghi log; `sample` và regex không bao giờ được in ra ngoài kết quả trên.

use std::io::{Read, Write};

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

/// Phải bằng `REGEX_SIZE_LIMIT` của CLI.
const REGEX_SIZE_LIMIT: usize = 2 << 20;
/// Tên capture group chỉ che một phần chuỗi khớp (giống CLI).
const SECRET_GROUP: &str = "secret";

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
        error: String,
    },
}

fn build(pattern: &str) -> Result<Regex, regex::Error> {
    RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
}

/// Che `text` bằng `regex`; trả văn bản đã che và số vùng khớp.
fn redact(regex: &Regex, id: &str, text: &str) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut count = 0;
    let has_secret = regex.capture_names().flatten().any(|n| n == SECRET_GROUP);
    for caps in regex.captures_iter(text) {
        let span = if has_secret {
            caps.name(SECRET_GROUP)
        } else {
            caps.get(0)
        };
        let Some(m) = span else { continue };
        if m.start() < last {
            continue;
        }
        out.push_str(&text[last..m.start()]);
        out.push_str(&format!("[REDACTED:{id}]"));
        last = m.end();
        count += 1;
    }
    out.push_str(&text[last..]);
    (out, count)
}

fn run(input: Input) -> Output {
    let mut compiled = Vec::with_capacity(input.patterns.len());
    for (index, p) in input.patterns.iter().enumerate() {
        match build(&p.regex) {
            Ok(re) => compiled.push((p.id.clone(), re)),
            Err(e) => {
                return Output::Err {
                    ok: false,
                    index,
                    id: p.id.clone(),
                    error: e.to_string(),
                }
            }
        }
    }
    let Some(sample) = input.sample else {
        return Output::Ok {
            ok: true,
            matches: 0,
            redacted: None,
        };
    };
    let mut text = sample;
    let mut matches = 0;
    for (id, re) in &compiled {
        let (next, n) = redact(re, id, &text);
        text = next;
        matches += n;
    }
    Output::Ok {
        ok: true,
        matches,
        redacted: Some(text),
    }
}

fn main() {
    let mut raw = String::new();
    let output = match std::io::stdin().read_to_string(&mut raw) {
        Ok(_) => match serde_json::from_str::<Input>(&raw) {
            Ok(input) => run(input),
            Err(e) => Output::Err {
                ok: false,
                index: 0,
                id: String::new(),
                error: format!("đầu vào không hợp lệ: {e}"),
            },
        },
        Err(e) => Output::Err {
            ok: false,
            index: 0,
            id: String::new(),
            error: format!("không đọc được stdin: {e}"),
        },
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
    fn tu_choi_lookaround_cua_node() {
        let out = json(&run(input(&[("ok", "a"), ("bad", r"(?<=a)b")], None)));
        assert!(out.contains("\"ok\":false"));
        assert!(out.contains("\"index\":1"));
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
