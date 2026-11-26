//! Dựng `Diff` từ tool `apply_patch` của Codex.
//!
//! Nguồn ưu tiên: `changes` trên event `patch_apply_end` (Codex tự tính, có số dòng thật
//! và đường dẫn tuyệt đối): `{ "<path>": { "type": "add", "content" } | { "type":
//! "update", "unified_diff", "move_path" } | { "type": "delete", "content" } }`. Không có
//! event đó (bản cũ, log bị cắt) thì phân tích chính input của tool (định dạng
//! `*** Begin Patch` / `*** Update File: <path>` / `@@` / `+` / `-`), khi đó hunk không có
//! số dòng.
//!
//! Một lần `apply_patch` có thể sửa nhiều file nhưng schema v1 chỉ có **một** `diff` mỗi
//! turn, nên các file được ghép thành một patch: một file thì chỉ có các hunk (như adapter
//! Claude Code); nhiều file thì mỗi file mở đầu bằng `--- <path>` / `+++ <path>`.
//! `Diff::path` là file đầu tiên, trừ khi patch đụng file nhạy cảm (`.env*`, `*.pem`,
//! `*.key`): khi đó lấy file nhạy cảm để pipeline nhận ra và bỏ toàn bộ nội dung turn
//! (`teamlens::pipeline::prepare::is_sensitive_path`). Đường dẫn để nguyên dạng tuyệt đối
//! (đường dẫn tương đối trong input được ghép với `cwd` của session); pipeline đổi sang
//! tương đối gốc repo.

use std::path::Path;

use serde_json::{Map, Value};
use tl_core::session::Diff;

/// Diff từ `patch_apply_end.changes`. `None` khi không có thay đổi nào đếm được.
pub(crate) fn from_changes(changes: &Map<String, Value>, cwd: Option<&Path>) -> Option<Diff> {
    let mut files = Vec::new();
    for (path, change) in changes {
        let path = resolve(cwd, path);
        let text = |k: &str| change.get(k).and_then(Value::as_str);
        let file = match change.get("type").and_then(Value::as_str) {
            Some("add") => FilePatch::whole(path, text("content").unwrap_or(""), '+'),
            Some("delete") => FilePatch::whole(path, text("content").unwrap_or(""), '-'),
            Some("update") => {
                let mut f = FilePatch::new(path);
                for line in split_lines(text("unified_diff").unwrap_or("")) {
                    f.line(line);
                }
                f
            }
            _ => continue,
        };
        files.push(file);
    }
    combine(files)
}

/// Diff dựng lại từ input của `apply_patch` (dùng khi không có `patch_apply_end`).
pub(crate) fn from_input(input: &str, cwd: Option<&Path>) -> Option<Diff> {
    let mut files: Vec<FilePatch> = Vec::new();
    // File mới (`Add File`) chưa có header hunk: thêm khi đóng file.
    let mut adding = false;
    let close = |files: &mut Vec<FilePatch>, adding: bool| {
        if let (true, Some(f)) = (adding, files.last_mut()) {
            f.body = format!("@@ -0,0 +1,{} @@\n{}", f.added, f.body);
        }
    };
    for raw in input.lines() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some((kind, path)) = file_header(line) {
            close(&mut files, adding);
            adding = kind == HeaderKind::Add;
            files.push(FilePatch::new(resolve(cwd, path)));
            continue;
        }
        if line.starts_with("*** ") {
            // `*** Begin Patch`, `*** End Patch`, `*** End of File`, `*** Move to: ...`.
            continue;
        }
        if let Some(f) = files.last_mut() {
            f.line(line);
        }
    }
    close(&mut files, adding);
    combine(files)
}

/// Các file `apply_patch` đụng tới (theo thứ tự trong input), đã ghép với `cwd`.
pub(crate) fn input_paths(input: &str, cwd: Option<&Path>) -> Vec<String> {
    input
        .lines()
        .filter_map(|l| file_header(l.strip_suffix('\r').unwrap_or(l)))
        .map(|(_, p)| resolve(cwd, p))
        .collect()
}

/// File nên đưa vào `Diff::path`/`tool.input.path`: file nhạy cảm đầu tiên, không thì
/// file đầu tiên.
pub(crate) fn primary_path(paths: &[String]) -> Option<&String> {
    paths
        .iter()
        .find(|p| is_sensitive(p))
        .or_else(|| paths.first())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeaderKind {
    Add,
    Update,
    Delete,
}

fn file_header(line: &str) -> Option<(HeaderKind, &str)> {
    let headers = [
        ("*** Add File: ", HeaderKind::Add),
        ("*** Update File: ", HeaderKind::Update),
        ("*** Delete File: ", HeaderKind::Delete),
    ];
    headers.iter().find_map(|(prefix, kind)| {
        let path = line.strip_prefix(prefix)?.trim();
        (!path.is_empty()).then_some((*kind, path))
    })
}

struct FilePatch {
    path: String,
    body: String,
    added: u32,
    removed: u32,
}

impl FilePatch {
    fn new(path: String) -> Self {
        Self {
            path,
            body: String::new(),
            added: 0,
            removed: 0,
        }
    }

    /// File thêm mới (`sign = '+'`) hoặc bị xóa (`'-'`): mọi dòng nội dung là một hunk.
    fn whole(path: String, content: &str, sign: char) -> Self {
        let lines = split_lines(content);
        let mut f = Self::new(path);
        let n = lines.len();
        f.body = if sign == '+' {
            format!("@@ -0,0 +1,{n} @@\n")
        } else {
            format!("@@ -1,{n} +0,0 @@\n")
        };
        for l in lines {
            f.line(&format!("{sign}{l}"));
        }
        f
    }

    fn line(&mut self, line: &str) {
        match line.as_bytes().first() {
            Some(b'+') => self.added += 1,
            Some(b'-') => self.removed += 1,
            _ => {}
        }
        self.body.push_str(line);
        self.body.push('\n');
    }
}

fn combine(mut files: Vec<FilePatch>) -> Option<Diff> {
    files.retain(|f| f.added > 0 || f.removed > 0);
    let paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
    let path = primary_path(&paths)?.clone();
    let added = files.iter().map(|f| f.added).sum();
    let removed = files.iter().map(|f| f.removed).sum();
    let patch = if files.len() == 1 {
        files.remove(0).body
    } else {
        files
            .iter()
            .map(|f| format!("--- {p}\n+++ {p}\n{}", f.body, p = f.path))
            .collect()
    };
    Some(Diff {
        path,
        patch,
        added,
        removed,
    })
}

/// Tách dòng, bỏ phần rỗng sau `\n` cuối (file kết thúc bằng xuống dòng).
fn split_lines(s: &str) -> Vec<&str> {
    if s.is_empty() {
        return Vec::new();
    }
    s.strip_suffix('\n')
        .unwrap_or(s)
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

/// Đường dẫn tương đối (vd. `src/a.ts` trong input) → ghép với `cwd`; tuyệt đối thì giữ.
/// Không dùng `Path::is_absolute` vì log Windows phải đọc được giống nhau trên mọi OS.
fn resolve(cwd: Option<&Path>, path: &str) -> String {
    let bytes = path.as_bytes();
    let absolute = path.starts_with(['/', '\\'])
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':');
    match cwd.map(|c| c.to_string_lossy()) {
        Some(cwd) if !absolute && !cwd.is_empty() => {
            let sep = if cwd.contains('\\') { '\\' } else { '/' };
            let rel = if sep == '\\' {
                path.replace('/', "\\")
            } else {
                path.to_owned()
            };
            format!("{}{sep}{rel}", cwd.trim_end_matches(['/', '\\']))
        }
        _ => path.to_owned(),
    }
}

/// Cùng quy tắc với `teamlens::pipeline::prepare::is_sensitive_path`.
fn is_sensitive(path: &str) -> bool {
    let name = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase();
    name.starts_with(".env") || name.ends_with(".pem") || name.ends_with(".key")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn update_change_keeps_unified_diff() {
        let changes = map(json!({
            "C:\\repo\\src\\a.ts": {
                "type": "update",
                "unified_diff": "@@ -3,2 +3,2 @@\n ctx\n-old\n+new\n",
                "move_path": null
            }
        }));
        let d = from_changes(&changes, None).unwrap();
        assert_eq!(d.path, "C:\\repo\\src\\a.ts");
        assert_eq!(d.patch, "@@ -3,2 +3,2 @@\n ctx\n-old\n+new\n");
        assert_eq!((d.added, d.removed), (1, 1));
    }

    #[test]
    fn add_and_delete_changes() {
        let changes = map(json!({
            "/r/new.md": { "type": "add", "content": "# A\n\nb\n" },
            "/r/old.md": { "type": "delete", "content": "x\n" }
        }));
        let d = from_changes(&changes, None).unwrap();
        assert_eq!(d.path, "/r/new.md");
        assert_eq!(
            d.patch,
            "--- /r/new.md\n+++ /r/new.md\n@@ -0,0 +1,3 @@\n+# A\n+\n+b\n\
             --- /r/old.md\n+++ /r/old.md\n@@ -1,1 +0,0 @@\n-x\n"
        );
        assert_eq!((d.added, d.removed), (3, 1));
    }

    #[test]
    fn sensitive_file_becomes_primary_path() {
        let changes = map(json!({
            "/r/a.rs": { "type": "add", "content": "a\n" },
            "/r/.env.local": { "type": "add", "content": "K=v\n" }
        }));
        let d = from_changes(&changes, None).unwrap();
        assert_eq!(d.path, "/r/.env.local");
    }

    #[test]
    fn parses_patch_input_with_relative_paths() {
        let input = "*** Begin Patch\n*** Add File: docs/new.md\n+hello\n+world\n\
                     *** Update File: src\\lib.rs\n@@ fn main\n-a\n+b\n c\n*** End Patch\n";
        let d = from_input(input, Some(Path::new("C:\\repo"))).unwrap();
        assert_eq!(d.path, "C:\\repo\\docs\\new.md");
        assert_eq!((d.added, d.removed), (3, 1));
        assert_eq!(
            d.patch,
            "--- C:\\repo\\docs\\new.md\n+++ C:\\repo\\docs\\new.md\n@@ -0,0 +1,2 @@\n+hello\n+world\n\
             --- C:\\repo\\src\\lib.rs\n+++ C:\\repo\\src\\lib.rs\n@@ fn main\n-a\n+b\n c\n"
        );
        assert_eq!(
            input_paths(input, Some(Path::new("/home/u/repo"))),
            vec!["/home/u/repo/docs/new.md", "/home/u/repo/src\\lib.rs"]
        );
    }

    #[test]
    fn single_file_input_and_empty_patch() {
        let input =
            "*** Begin Patch\r\n*** Update File: C:\\r\\a.txt\r\n@@\r\n-x\r\n+y\r\n*** End Patch";
        let d = from_input(input, None).unwrap();
        assert_eq!(d.path, "C:\\r\\a.txt");
        assert_eq!(d.patch, "@@\n-x\n+y\n");
        // Chỉ xóa file (không nội dung) hoặc patch rỗng: không có diff.
        assert!(from_input("*** Begin Patch\n*** Delete File: a\n*** End Patch\n", None).is_none());
        assert!(from_input("không phải patch", None).is_none());
    }
}
