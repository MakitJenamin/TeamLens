//! `session.instruction_files` (RULES.md mục 4): chỉ đường dẫn và kích thước file hướng
//! dẫn ở gốc repo. **Không đọc, không gửi nội dung** — chỉ gọi `metadata`.

use std::path::Path;

use tl_core::session::InstructionFile;

/// Các file hướng dẫn được xét, đường dẫn tương đối gốc repo (dùng `/`).
pub const INSTRUCTION_FILES: &[&str] = &[
    "CLAUDE.md",
    "AGENTS.md",
    ".github/copilot-instructions.md",
    ".claude/CLAUDE.md",
];

/// Các file hướng dẫn có mặt ở `repo_root` cùng kích thước (byte), theo thứ tự
/// [`INSTRUCTION_FILES`]. Không có file nào thì trả vec rỗng (rule `no-instruction-file`).
pub fn instruction_files(repo_root: &Path) -> Vec<InstructionFile> {
    INSTRUCTION_FILES
        .iter()
        .filter_map(|rel| {
            let meta = std::fs::metadata(repo_root.join(rel)).ok()?;
            meta.is_file().then(|| InstructionFile {
                path: (*rel).to_owned(),
                bytes: meta.len(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chi_lay_file_co_mat_va_kich_thuoc() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "abc").unwrap();
        std::fs::create_dir_all(dir.path().join(".claude")).unwrap();
        std::fs::write(dir.path().join(".claude/CLAUDE.md"), "12345").unwrap();
        // Thư mục trùng tên không tính là file.
        std::fs::create_dir_all(dir.path().join("CLAUDE.md")).unwrap();
        let files = instruction_files(dir.path());
        assert_eq!(
            files,
            vec![
                InstructionFile {
                    path: "AGENTS.md".into(),
                    bytes: 3
                },
                InstructionFile {
                    path: ".claude/CLAUDE.md".into(),
                    bytes: 5
                },
            ]
        );
        assert!(instruction_files(&dir.path().join("khong-co")).is_empty());
    }
}
