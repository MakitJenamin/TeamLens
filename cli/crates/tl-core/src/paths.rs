//! Đổi đường dẫn tuyệt đối thành dạng không lộ thông tin máy (spec mục 6.3) — task M1.5.
//!
//! Quy tắc, theo thứ tự ưu tiên:
//!
//! 1. Trong gốc repo → đường dẫn tương đối dùng `/`
//!    (`C:\Users\a\repo\src\a.rs` → `src/a.rs`; chính gốc repo → `.`).
//! 2. Trong thư mục home của user → `~/...` (`C:\Users\a\Documents\x` → `~/Documents/x`).
//! 3. Thư mục home của user khác (`X:\Users\<tên>`, `/home/<tên>`, `/Users/<tên>`)
//!    hoặc đường dẫn mạng UNC (`\\<tên máy>\<share>`) → `[PATH]/...`.
//! 4. Còn lại giữ nguyên (ví dụ `C:\Program Files\Git\bin\git.exe`).
//!
//! So khớp chấp nhận cả `\` lẫn `/`, dạng git-bash (`/c/Users/...`), dấu phân cách
//! lặp (`C:\\Users\\...` trong chuỗi escape) và không phân biệt hoa thường với
//! đường dẫn Windows.
//!
//! ```
//! use tl_core::paths::PathContext;
//!
//! let ctx = PathContext::new(Some(r"C:\Users\alice\code\repo"), Some(r"C:\Users\alice"));
//! assert_eq!(ctx.relativize_path(r"c:\users\alice\code\repo\src\a.rs"), "src/a.rs");
//! assert_eq!(
//!     ctx.relativize_text(r"lỗi ở C:\Users\alice\code\repo\src\a.rs:12 và C:/Users/alice/.cargo"),
//!     "lỗi ở src/a.rs:12 và ~/.cargo"
//! );
//! ```

use std::sync::LazyLock;

use regex::{Captures, Regex};

/// Thay thế cho đường dẫn ngoài repo/home có chứa tên user khác hoặc tên máy.
pub const PATH_PLACEHOLDER: &str = "[PATH]";

/// Ký tự được coi là một phần đường dẫn khi quét văn bản tự do (sau gốc).
/// Không gồm khoảng trắng, dấu nháy, `:` (để `a.rs:12` giữ số dòng) và ngoặc.
const REST: &str = r#"(?P<rest>(?:[\\/][^\s"'`<>|*?:,;()\[\]{}]*)?)"#;

/// Thư mục home của user bất kỳ (dùng cho quy tắc 3).
static OTHER_HOME: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r#"(?i)(?:\b[a-z]:|/[a-z])[\\/]+users[\\/]+[^\\/\s"'`<>|:*?]+{REST}"#
    ))
});
static UNIX_HOME: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r#"(?P<lead>^|[\s"'`=(\[{{,;])/(?:home|Users)/[^/\s"'`<>|:*?]+{REST}"#
    ))
});
static UNC: LazyLock<Regex> = LazyLock::new(|| {
    compile(&format!(
        r#"(?P<lead>^|[\s"'`=(\[{{,;])\\\\[A-Za-z0-9._-]+\\[^\\\s"'`<>|:*?]+{REST}"#
    ))
});

fn compile(pattern: &str) -> Regex {
    match Regex::new(pattern) {
        Ok(re) => re,
        // Pattern là hằng số hoặc dựng từ chuỗi đã escape; lỗi là lỗi lập trình.
        Err(err) => panic!("regex đường dẫn không hợp lệ: {err}"),
    }
}

/// Một thư mục gốc (repo hoặc home) đã chuẩn bị sẵn để so khớp.
#[derive(Debug, Clone)]
struct Root {
    /// Regex tìm gốc trong văn bản tự do, có group `rest`.
    regex: Regex,
    /// Dạng chuẩn hóa để so tiền tố (xem [`normalize`]).
    normalized: String,
    /// Đường dẫn Windows: so khớp không phân biệt hoa thường.
    windows: bool,
}

impl Root {
    fn new(path: &str) -> Option<Self> {
        let normalized = normalize(path);
        let comps: Vec<&str> = normalized.split('/').filter(|c| !c.is_empty()).collect();
        let first = *comps.first()?;
        let drive = drive_letter(first);
        let windows = drive.is_some() || path.contains('\\');

        let mut pattern = String::new();
        if windows {
            pattern.push_str("(?i)");
        }
        let mut rest_comps = comps.as_slice();
        if let Some(letter) = drive {
            pattern.push_str(&format!("(?:\\b{letter}:|/{letter})"));
            rest_comps = &comps[1..];
        }
        for comp in rest_comps {
            pattern.push_str(r"[\\/]+");
            pattern.push_str(&regex::escape(comp));
        }
        if pattern.is_empty() || pattern == "(?i)" {
            return None;
        }
        pattern.push_str(REST);
        Some(Self {
            regex: compile(&pattern),
            normalized,
            windows,
        })
    }

    /// Phần còn lại (đã chuẩn hóa, không có `/` đầu) nếu `normalized_path` nằm trong gốc.
    fn strip<'a>(&self, normalized_path: &'a str) -> Option<&'a str> {
        let n = self.normalized.len();
        let head = normalized_path.get(..n)?;
        let same = if self.windows {
            head.to_lowercase() == self.normalized.to_lowercase()
        } else {
            head == self.normalized
        };
        if !same {
            return None;
        }
        let tail = &normalized_path[n..];
        if tail.is_empty() {
            Some("")
        } else {
            tail.strip_prefix('/')
        }
    }

    /// Thay mọi lần xuất hiện của gốc trong `text` bằng `prefix` + phần còn lại.
    fn replace_in(&self, text: &str, render: impl Fn(&str) -> String) -> String {
        replace_paths(&self.regex, text, render)
    }
}

/// Ký tự ổ đĩa (viết thường) nếu thành phần đầu là `C:` (hoặc `c` từ dạng git-bash
/// đã chuẩn hóa thành `c:`).
fn drive_letter(first: &str) -> Option<char> {
    let mut chars = first.chars();
    match (chars.next(), chars.next(), chars.next()) {
        (Some(c), Some(':'), None) if c.is_ascii_alphabetic() => Some(c.to_ascii_lowercase()),
        _ => None,
    }
}

/// Chuẩn hóa một đường dẫn để so tiền tố: `\` → `/`, gộp `/` lặp, bỏ `/` cuối,
/// `/c/...` (git-bash) → `c:/...`, ký tự ổ đĩa viết thường.
fn normalize(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        let c = if c == '\\' { '/' } else { c };
        if c == '/' && out.ends_with('/') {
            continue;
        }
        out.push(c);
    }
    // Dạng git-bash: /c hoặc /c/...
    let bytes = out.as_bytes();
    if bytes.len() >= 2
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && (bytes.len() == 2 || bytes[2] == b'/')
    {
        out = format!("{}:{}", (bytes[1] as char).to_ascii_lowercase(), &out[2..]);
    } else if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        out = format!("{}{}", (bytes[0] as char).to_ascii_lowercase(), &out[1..]);
    }
    while out.len() > 1 && out.ends_with('/') && !out.ends_with(":/") {
        out.pop();
    }
    out
}

/// Phần sau gốc trong văn bản → dạng `a/b/c` (bỏ phân cách đầu, đổi `\` thành `/`).
fn clean_rest(rest: &str) -> String {
    let mut out = String::with_capacity(rest.len());
    for c in rest.chars() {
        let c = if c == '\\' { '/' } else { c };
        if c == '/' && (out.is_empty() || out.ends_with('/')) {
            continue;
        }
        out.push(c);
    }
    out
}

/// Ký tự có thể nối tiếp tên thư mục (nếu gốc bị theo sau bởi ký tự này thì
/// đó là thư mục khác, ví dụ `repo2` so với `repo`).
fn continues_name(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '~' | '$' | '@' | '+')
}

fn replace_paths(re: &Regex, text: &str, render: impl Fn(&str) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for caps in re.captures_iter(text) {
        let Some(whole) = caps.get(0) else { continue };
        let rest = caps.name("rest").map_or("", |m| m.as_str());
        if rest.is_empty()
            && text[whole.end()..]
                .chars()
                .next()
                .is_some_and(continues_name)
        {
            continue;
        }
        out.push_str(&text[last..whole.start()]);
        out.push_str(lead(&caps));
        out.push_str(&render(&clean_rest(rest)));
        last = whole.end();
    }
    out.push_str(&text[last..]);
    out
}

fn lead<'a>(caps: &Captures<'a>) -> &'a str {
    caps.name("lead").map_or("", |m| m.as_str())
}

fn join(prefix: &str, rest: &str) -> String {
    if rest.is_empty() {
        prefix.to_owned()
    } else {
        format!("{prefix}/{rest}")
    }
}

/// Ngữ cảnh đổi đường dẫn cho một session: gốc repo và thư mục home trên máy.
///
/// Tạo một lần cho mỗi session (biên dịch regex), dùng lại cho mọi turn.
#[derive(Debug, Clone, Default)]
pub struct PathContext {
    repo: Option<Root>,
    home: Option<Root>,
}

impl PathContext {
    /// `repo_root`: thư mục gốc repo (chứa `.git`) mà session thuộc về.
    /// `home_dir`: thư mục home của user hiện tại (ví dụ `%USERPROFILE%`).
    /// Truyền `None` (hoặc chuỗi rỗng) nếu không biết; quy tắc tương ứng bị bỏ qua.
    pub fn new(repo_root: Option<&str>, home_dir: Option<&str>) -> Self {
        Self {
            repo: repo_root.and_then(Root::new),
            home: home_dir.and_then(Root::new),
        }
    }

    /// Đổi một trường chỉ chứa đúng một đường dẫn (ví dụ `cwd`, `file_path` của tool).
    ///
    /// Khác [`Self::relativize_text`], hàm này chấp nhận khoảng trắng trong đường dẫn.
    /// Đường dẫn tương đối hoặc không thuộc quy tắc nào được giữ nguyên.
    pub fn relativize_path(&self, path: &str) -> String {
        let normalized = normalize(path);
        if let Some(rest) = self.repo.as_ref().and_then(|r| r.strip(&normalized)) {
            return if rest.is_empty() {
                ".".to_owned()
            } else {
                rest.to_owned()
            };
        }
        if let Some(rest) = self.home.as_ref().and_then(|h| h.strip(&normalized)) {
            return join("~", rest);
        }
        self.relativize_text(path)
    }

    /// Đổi mọi đường dẫn tuyệt đối xuất hiện trong văn bản tự do (prompt, câu trả
    /// lời, output lệnh...).
    ///
    /// Phần sau gốc dừng ở khoảng trắng, dấu nháy, `:` và ngoặc; gốc repo/home có
    /// khoảng trắng vẫn khớp đúng vì được so nguyên văn.
    pub fn relativize_text(&self, text: &str) -> String {
        let mut out = match &self.repo {
            Some(repo) => repo.replace_in(text, |rest| {
                if rest.is_empty() {
                    ".".to_owned()
                } else {
                    rest.to_owned()
                }
            }),
            None => text.to_owned(),
        };
        if let Some(home) = &self.home {
            out = home.replace_in(&out, |rest| join("~", rest));
        }
        for re in [&*OTHER_HOME, &*UNIX_HOME, &*UNC] {
            out = replace_paths(re, &out, |rest| join(PATH_PLACEHOLDER, rest));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win() -> PathContext {
        PathContext::new(Some(r"C:\Users\alice\code\repo"), Some(r"C:\Users\alice"))
    }

    #[test]
    fn repo_paths_become_relative() {
        let ctx = win();
        for input in [
            r"C:\Users\alice\code\repo\src\a.rs",
            r"c:\users\ALICE\code\repo\src\a.rs",
            "C:/Users/alice/code/repo/src/a.rs",
            "/c/Users/alice/code/repo/src/a.rs",
            r"C:\\Users\\alice\\code\\repo\\src\\a.rs",
        ] {
            assert_eq!(ctx.relativize_path(input), "src/a.rs", "input: {input}");
            assert_eq!(ctx.relativize_text(input), "src/a.rs", "input: {input}");
        }
        assert_eq!(ctx.relativize_path(r"C:\Users\alice\code\repo"), ".");
        assert_eq!(ctx.relativize_path(r"C:\Users\alice\code\repo\"), ".");
    }

    #[test]
    fn sibling_dir_is_not_repo() {
        let ctx = win();
        assert_eq!(
            ctx.relativize_path(r"C:\Users\alice\code\repo2\x.rs"),
            "~/code/repo2/x.rs"
        );
        assert_eq!(
            ctx.relativize_text(r"C:\Users\alice\code\repo2\x.rs"),
            "~/code/repo2/x.rs"
        );
        assert_eq!(ctx.relativize_text(r"C:\Users\alicex\y"), "[PATH]/y");
    }

    #[test]
    fn home_paths_become_tilde() {
        let ctx = win();
        assert_eq!(
            ctx.relativize_path(r"C:\Users\alice\.claude\settings.json"),
            "~/.claude/settings.json"
        );
        assert_eq!(ctx.relativize_path(r"C:\Users\alice"), "~");
        assert_eq!(ctx.relativize_text("cd C:/Users/alice && ls"), "cd ~ && ls");
    }

    #[test]
    fn other_users_and_unc_hidden() {
        let ctx = win();
        assert_eq!(
            ctx.relativize_text(r"xem C:\Users\bob\notes.txt"),
            "xem [PATH]/notes.txt"
        );
        assert_eq!(
            ctx.relativize_text("ls /home/bob/project"),
            "ls [PATH]/project"
        );
        assert_eq!(ctx.relativize_text("\"/Users/carol/x\""), "\"[PATH]/x\"");
        assert_eq!(
            ctx.relativize_text(r"copy \\BUILD-PC01\share\a.zip ."),
            "copy [PATH]/a.zip ."
        );
    }

    #[test]
    fn unrelated_paths_untouched() {
        let ctx = win();
        for text in [
            r"C:\Program Files\Git\bin\git.exe",
            "src/a.rs",
            "https://github.com/org/repo/blob/main/src/a.rs",
            "/usr/bin/env bash",
            r"regex \d+\s",
        ] {
            assert_eq!(ctx.relativize_text(text), text);
        }
    }

    #[test]
    fn text_keeps_line_numbers_and_punctuation() {
        let ctx = win();
        assert_eq!(
            ctx.relativize_text(r"error at C:\Users\alice\code\repo\src\main.rs:12:5, xem lại."),
            "error at src/main.rs:12:5, xem lại."
        );
        assert_eq!(
            ctx.relativize_text(r#"{"file_path":"C:\\Users\\alice\\code\\repo\\Cargo.toml"}"#),
            r#"{"file_path":"Cargo.toml"}"#
        );
        assert_eq!(
            ctx.relativize_text(r"cd C:\Users\alice\code\repo && cargo test"),
            "cd . && cargo test"
        );
    }

    #[test]
    fn roots_with_spaces_and_unicode() {
        let ctx = PathContext::new(Some(r"D:\Dự án\my repo"), Some(r"C:\Users\Nguyễn Văn A"));
        assert_eq!(
            ctx.relativize_path(r"d:\dự án\my repo\src\tệp mới.rs"),
            "src/tệp mới.rs"
        );
        assert_eq!(
            ctx.relativize_text(r"mở D:\Dự án\my repo\README.md"),
            "mở README.md"
        );
        assert_eq!(
            ctx.relativize_text(r"C:\Users\Nguyễn Văn A\AppData\Local\teamlens"),
            "~/AppData/Local/teamlens"
        );
    }

    #[test]
    fn unix_roots_are_case_sensitive() {
        let ctx = PathContext::new(Some("/home/dev/repo"), Some("/home/dev"));
        assert_eq!(
            ctx.relativize_path("/home/dev/repo/src/lib.rs"),
            "src/lib.rs"
        );
        assert_eq!(
            ctx.relativize_text("vim /home/dev/repo/src/lib.rs"),
            "vim src/lib.rs"
        );
        assert_eq!(ctx.relativize_text("ls /home/dev/.config"), "ls ~/.config");
        assert_eq!(ctx.relativize_text("/HOME/DEV/REPO/x"), "/HOME/DEV/REPO/x");
    }

    #[test]
    fn empty_context_only_hides_user_dirs() {
        let ctx = PathContext::default();
        assert_eq!(ctx.relativize_path(r"C:\Users\alice\x"), "[PATH]/x");
        assert_eq!(ctx.relativize_path("src/a.rs"), "src/a.rs");
        let ctx = PathContext::new(Some(""), Some(""));
        assert_eq!(ctx.relativize_text("không có gì"), "không có gì");
    }

    #[test]
    fn normalize_forms() {
        assert_eq!(normalize(r"C:\a\\b\"), "c:/a/b");
        assert_eq!(normalize("/c/a/b"), "c:/a/b");
        assert_eq!(normalize("/"), "/");
        assert_eq!(normalize("/home/x/"), "/home/x");
    }
}
