//! Dựng `Diff` (unified diff dạng text) từ tool sửa file của Claude Code.
//!
//! Nguồn ưu tiên: `toolUseResult.structuredPatch` trên dòng `tool_result` (Claude Code tự
//! tính, có số dòng thật). Không có thì dựng lại từ input của tool (`Edit`, `MultiEdit`,
//! `Write`), khi đó không biết số dòng thật nên header hunk luôn bắt đầu từ dòng 1.
//!
//! `Diff::path` là đường dẫn tuyệt đối nguyên từ log; pipeline (M1.7) đổi sang tương đối.

use serde_json::{Map, Value};
use tl_core::session::Diff;

/// Diff từ `toolUseResult` của Edit/Write/MultiEdit (`structuredPatch`, hoặc `content`
/// khi `type = "create"`). `None` nếu không phải kết quả sửa file.
pub(crate) fn from_tool_result(result: &Value) -> Option<Diff> {
    let path = result.get("filePath")?.as_str()?;
    if let Some(hunks) = result.get("structuredPatch").and_then(Value::as_array) {
        if !hunks.is_empty() {
            return from_structured_patch(path, hunks);
        }
    }
    if result.get("type").and_then(Value::as_str) == Some("create") {
        return created_file(path, result.get("content")?.as_str()?);
    }
    None
}

/// Diff dựng lại từ input của tool, dùng khi log không có `structuredPatch`.
pub(crate) fn from_tool_input(name: &str, input: &Map<String, Value>) -> Option<Diff> {
    let path = input.get("file_path")?.as_str()?;
    match name {
        "Write" => created_file(path, input.get("content")?.as_str()?),
        "Edit" => {
            let old = input.get("old_string")?.as_str()?;
            let new = input.get("new_string")?.as_str()?;
            let mut b = PatchBuilder::default();
            b.replace(old, new);
            b.finish(path)
        }
        "MultiEdit" => {
            let mut b = PatchBuilder::default();
            for edit in input.get("edits")?.as_array()? {
                let old = edit.get("old_string").and_then(Value::as_str)?;
                let new = edit.get("new_string").and_then(Value::as_str)?;
                b.replace(old, new);
            }
            b.finish(path)
        }
        _ => None,
    }
}

fn from_structured_patch(path: &str, hunks: &[Value]) -> Option<Diff> {
    let mut b = PatchBuilder::default();
    for hunk in hunks {
        let num = |k: &str| hunk.get(k).and_then(Value::as_u64).unwrap_or(0);
        b.patch.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            num("oldStart"),
            num("oldLines"),
            num("newStart"),
            num("newLines")
        ));
        for line in hunk.get("lines").and_then(Value::as_array)?.iter() {
            b.line(line.as_str()?);
        }
    }
    b.finish(path)
}

/// File mới tạo: mọi dòng là dòng thêm.
fn created_file(path: &str, content: &str) -> Option<Diff> {
    let lines = split_lines(content);
    let mut b = PatchBuilder::default();
    b.patch
        .push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
    for l in lines {
        b.line(&format!("+{l}"));
    }
    b.finish(path)
}

/// Tách dòng, bỏ phần rỗng sau `\n` cuối (file kết thúc bằng xuống dòng).
fn split_lines(s: &str) -> Vec<&str> {
    if s.is_empty() {
        return Vec::new();
    }
    s.strip_suffix('\n').unwrap_or(s).split('\n').collect()
}

#[derive(Default)]
struct PatchBuilder {
    patch: String,
    added: u32,
    removed: u32,
}

impl PatchBuilder {
    fn line(&mut self, line: &str) {
        match line.as_bytes().first() {
            Some(b'+') => self.added += 1,
            Some(b'-') => self.removed += 1,
            _ => {}
        }
        self.patch.push_str(line);
        self.patch.push('\n');
    }

    /// Một hunk "thay `old` bằng `new`" (không có dòng ngữ cảnh, không biết số dòng thật).
    fn replace(&mut self, old: &str, new: &str) {
        let old = split_lines(old);
        let new = split_lines(new);
        self.patch
            .push_str(&format!("@@ -1,{} +1,{} @@\n", old.len(), new.len()));
        for l in old {
            self.line(&format!("-{l}"));
        }
        for l in new {
            self.line(&format!("+{l}"));
        }
    }

    fn finish(self, path: &str) -> Option<Diff> {
        if path.is_empty() || (self.added == 0 && self.removed == 0) {
            return None;
        }
        Some(Diff {
            path: path.to_owned(),
            patch: self.patch,
            added: self.added,
            removed: self.removed,
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn structured_patch_to_unified_text() {
        let r = json!({
            "filePath": "C:\\repo\\src\\a.ts",
            "structuredPatch": [{
                "oldStart": 12, "oldLines": 3, "newStart": 12, "newLines": 3,
                "lines": [" a", "-  return 1;", "+  return 2;", " }", "\\ No newline at end of file"]
            }]
        });
        let d = from_tool_result(&r).unwrap();
        assert_eq!(d.path, "C:\\repo\\src\\a.ts");
        assert_eq!(
            d.patch,
            "@@ -12,3 +12,3 @@\n a\n-  return 1;\n+  return 2;\n }\n\\ No newline at end of file\n"
        );
        assert_eq!((d.added, d.removed), (1, 1));
    }

    #[test]
    fn create_uses_content() {
        let r = json!({ "type": "create", "filePath": "/r/new.rs", "content": "fn a() {}\nfn b() {}\n", "structuredPatch": [] });
        let d = from_tool_result(&r).unwrap();
        assert_eq!(d.patch, "@@ -0,0 +1,2 @@\n+fn a() {}\n+fn b() {}\n");
        assert_eq!((d.added, d.removed), (2, 0));
    }

    #[test]
    fn non_edit_result_has_no_diff() {
        assert!(from_tool_result(&json!({ "stdout": "ok" })).is_none());
        assert!(from_tool_result(&json!("Error: lỗi")).is_none());
        let empty = json!({ "type": "update", "filePath": "/r/a", "structuredPatch": [] });
        assert!(from_tool_result(&empty).is_none());
    }

    #[test]
    fn edit_and_multi_edit_from_input() {
        let input = json!({ "file_path": "/r/a.rs", "old_string": "x\ny", "new_string": "z" });
        let d = from_tool_input("Edit", input.as_object().unwrap()).unwrap();
        assert_eq!(d.patch, "@@ -1,2 +1,1 @@\n-x\n-y\n+z\n");
        assert_eq!((d.added, d.removed), (1, 2));

        let input = json!({ "file_path": "/r/a.rs", "edits": [
            { "old_string": "a", "new_string": "b" },
            { "old_string": "c", "new_string": "d\ne" }
        ]});
        let d = from_tool_input("MultiEdit", input.as_object().unwrap()).unwrap();
        assert_eq!((d.added, d.removed), (3, 2));
        assert_eq!(d.patch.matches("@@ -1,").count(), 2);

        let input = json!({ "file_path": "/r/a.rs", "content": "one" });
        let d = from_tool_input("Write", input.as_object().unwrap()).unwrap();
        assert_eq!(d.patch, "@@ -0,0 +1,1 @@\n+one\n");

        let input = json!({ "command": "ls" });
        assert!(from_tool_input("Bash", input.as_object().unwrap()).is_none());
    }
}
