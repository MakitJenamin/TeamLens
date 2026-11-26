//! Đọc thông tin git của thư mục làm việc (spec 6.1 bước 2) — task M1.4.
//!
//! Từ `cwd` của session, đi ngược lên tìm `.git`, rồi đọc **mọi** remote trong file
//! config của repo.
//!
//! # Vì sao đọc file `.git/config` thay vì gọi `git remote -v`
//!
//! - Không phụ thuộc `git.exe` có trong `PATH`: daemon chạy bằng Task Scheduler có
//!   môi trường khác shell của người dùng, và máy có thể chỉ có git nhúng trong IDE.
//! - Không bật cửa sổ console thoáng qua khi daemon (không có console) gọi tiến trình con.
//! - Không bị chặn bởi kiểm tra `safe.directory` ("dubious ownership") khi repo nằm ở
//!   ổ đĩa ngoài/thư mục do user khác tạo — chuyện hay gặp trên Windows.
//! - Nhanh, không tạo tiến trình cho từng session; kết quả lại được cache theo đường dẫn.
//!
//! Giới hạn đã biết (đều nghiêng về phía "ngoài phạm vi", tức an toàn): không xử lý
//! `[include]`/`[includeIf]`, `url.<base>.insteadOf`; repo bare hoặc biến môi trường
//! `GIT_DIR` không được hỗ trợ.
//!
//! Hỗ trợ:
//! - `.git` là thư mục (repo thường);
//! - `.git` là file `gitdir: <đường dẫn>` (worktree từ `git worktree add`, submodule).
//!   Worktree dùng config chung qua file `commondir`; submodule có config riêng trong
//!   `.git/modules/<tên>`. Với submodule, repo gần `cwd` nhất (chính submodule) được dùng.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Một remote trong config (`[remote "<name>"]`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRemote {
    pub name: String,
    /// Mọi giá trị `url = ...` (git cho phép nhiều dòng `url`).
    pub urls: Vec<String>,
}

/// Repo git chứa một `cwd`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRepo {
    /// Thư mục gốc working tree (thư mục chứa `.git`).
    pub root: PathBuf,
    /// Thư mục git thật (`.git`, hoặc `.git/worktrees/<tên>`, `.git/modules/<tên>`).
    pub git_dir: PathBuf,
    /// Remote theo thứ tự trong config, `origin` được đưa lên đầu.
    pub remotes: Vec<GitRemote>,
    /// Nhánh hiện tại; `None` khi detached HEAD hoặc không đọc được.
    pub branch: Option<String>,
}

impl GitRepo {
    /// Mọi URL remote theo thứ tự ưu tiên (`origin` trước), dùng cho
    /// `tl_core::scope::RepoPatterns::decide`.
    pub fn remote_urls(&self) -> impl Iterator<Item = &str> {
        self.remotes
            .iter()
            .flat_map(|r| r.urls.iter().map(String::as_str))
    }
}

/// Tìm repo chứa `cwd` (đi ngược lên tới gốc ổ đĩa) và đọc remote, nhánh.
///
/// Trả `None` nếu `cwd` không tuyệt đối, không nằm trong git repo, hoặc không đọc
/// được thư mục git. Repo không có remote vẫn trả `Some` với `remotes` rỗng.
pub fn find_repo(cwd: &Path) -> Option<GitRepo> {
    if !cwd.is_absolute() {
        return None;
    }
    for dir in cwd.ancestors() {
        let dot_git = dir.join(".git");
        let Ok(meta) = fs::metadata(&dot_git) else {
            continue;
        };
        let git_dir = if meta.is_dir() {
            dot_git
        } else if meta.is_file() {
            resolve_gitdir_file(&dot_git)?
        } else {
            continue;
        };
        return Some(read_repo(dir.to_path_buf(), git_dir));
    }
    None
}

/// Đọc file `.git` dạng `gitdir: <đường dẫn>`; đường dẫn tương đối tính từ thư mục
/// chứa file.
fn resolve_gitdir_file(dot_git: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(dot_git).ok()?;
    let target = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:"))?
        .trim();
    if target.is_empty() {
        return None;
    }
    let path = Path::new(target);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        dot_git.parent()?.join(path)
    };
    resolved.is_dir().then_some(resolved)
}

fn read_repo(root: PathBuf, git_dir: PathBuf) -> GitRepo {
    // Worktree: config chung nằm ở `commondir` (thường là `../..`).
    let common_dir = fs::read_to_string(git_dir.join("commondir"))
        .ok()
        .map(|s| {
            let p = PathBuf::from(s.trim());
            if p.is_absolute() {
                p
            } else {
                git_dir.join(p)
            }
        })
        .unwrap_or_else(|| git_dir.clone());

    let mut config = fs::read_to_string(common_dir.join("config")).unwrap_or_default();
    // Config riêng của worktree (extensions.worktreeConfig), nếu có.
    if let Ok(extra) = fs::read_to_string(git_dir.join("config.worktree")) {
        config.push('\n');
        config.push_str(&extra);
    }

    let branch = fs::read_to_string(git_dir.join("HEAD"))
        .ok()
        .and_then(|head| parse_head(&head));

    GitRepo {
        root,
        git_dir,
        remotes: parse_remotes(&config),
        branch,
    }
}

/// Lấy tên nhánh từ nội dung file `HEAD` (`ref: refs/heads/<nhánh>`).
pub fn parse_head(head: &str) -> Option<String> {
    head.trim()
        .strip_prefix("ref:")?
        .trim()
        .strip_prefix("refs/heads/")
        .filter(|b| !b.is_empty())
        .map(str::to_string)
}

/// Đọc mọi remote và URL của chúng từ nội dung file config git (định dạng INI của git).
///
/// Hỗ trợ `[remote "tên"]` và dạng cũ `[remote.tên]`, key không phân biệt hoa thường,
/// giá trị có ngoặc kép, comment `#`/`;`. Remote trùng tên (ví dụ từ `config.worktree`)
/// được gộp URL. `origin` được đưa lên đầu, các remote khác giữ thứ tự xuất hiện.
pub fn parse_remotes(config: &str) -> Vec<GitRemote> {
    let mut remotes: Vec<GitRemote> = Vec::new();
    let mut current: Option<String> = None;

    for raw in config.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') {
            current = parse_section(line);
            continue;
        }
        let Some(name) = &current else {
            continue;
        };
        let (key, value) = match line.split_once('=') {
            Some((k, v)) => (k.trim(), parse_value(v)),
            None => continue,
        };
        if !key.eq_ignore_ascii_case("url") || value.is_empty() {
            continue;
        }
        match remotes.iter_mut().find(|r| &r.name == name) {
            Some(r) => {
                if !r.urls.contains(&value) {
                    r.urls.push(value);
                }
            }
            None => remotes.push(GitRemote {
                name: name.clone(),
                urls: vec![value],
            }),
        }
    }

    if let Some(pos) = remotes.iter().position(|r| r.name == "origin") {
        let origin = remotes.remove(pos);
        remotes.insert(0, origin);
    }
    remotes
}

/// `[remote "origin"]` hoặc `[remote.origin]` → `Some("origin")`; section khác → `None`.
fn parse_section(line: &str) -> Option<String> {
    let inner = line.strip_prefix('[')?;
    let end = inner.rfind(']')?;
    let inner = inner[..end].trim();
    if let Some((section, rest)) = inner.split_once(char::is_whitespace) {
        if !section.eq_ignore_ascii_case("remote") {
            return None;
        }
        let rest = rest.trim();
        let quoted = rest.strip_prefix('"')?.strip_suffix('"')?;
        // Subsection trong ngoặc kép: `\"` và `\\` là escape.
        let mut name = String::new();
        let mut chars = quoted.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                name.extend(chars.next());
            } else {
                name.push(c);
            }
        }
        return Some(name);
    }
    let (section, sub) = inner.split_once('.')?;
    section
        .eq_ignore_ascii_case("remote")
        .then(|| sub.to_lowercase())
}

/// Giá trị sau dấu `=`: bỏ comment ngoài ngoặc kép, bỏ ngoặc kép, xử lý escape.
fn parse_value(raw: &str) -> String {
    let mut out = String::new();
    let mut in_quote = false;
    let mut chars = raw.trim().chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => in_quote = !in_quote,
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => {}
            },
            '#' | ';' if !in_quote => break,
            _ => out.push(c),
        }
    }
    out.trim().to_string()
}

/// Cache kết quả tìm repo theo `cwd` (spec 6.1: "kết quả cache theo đường dẫn").
///
/// Daemon chạy lâu nên nên gọi [`RepoResolver::clear`] mỗi khi tải lại pattern
/// (mỗi 1 giờ) để thấy remote mới.
#[derive(Debug, Default)]
pub struct RepoResolver {
    cache: HashMap<PathBuf, Option<Arc<GitRepo>>>,
}

impl RepoResolver {
    pub fn new() -> Self {
        Self::default()
    }

    /// Repo chứa `cwd` (có cache). `None` nếu không phải git repo.
    pub fn resolve(&mut self, cwd: &Path) -> Option<Arc<GitRepo>> {
        if let Some(hit) = self.cache.get(cwd) {
            return hit.clone();
        }
        let found = find_repo(cwd).map(Arc::new);
        self.cache.insert(cwd.to_path_buf(), found.clone());
        found
    }

    /// Xóa cache.
    pub fn clear(&mut self) {
        self.cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_remotes_nhieu_dang() {
        let config = r#"
[core]
	repositoryformatversion = 0
	url = https://khong-phai-remote.example/a/b
[remote "upstream"]
	url = git@github.com:acme/shop.git
	fetch = +refs/heads/*:refs/remotes/upstream/*
[remote "origin"]
	URL = "https://github.com/me/shop.git" # fork cá nhân
	url = https://github.com/me/shop-mirror.git
[remote.legacy]
	url = https://gitlab.com/acme/old.git ; comment
[remote "with \"quote\""]
	url = https://github.com/acme/q.git
[branch "main"]
	remote = origin
"#;
        let remotes = parse_remotes(config);
        let names: Vec<&str> = remotes.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["origin", "upstream", "legacy", "with \"quote\""]);
        assert_eq!(
            remotes[0].urls,
            [
                "https://github.com/me/shop.git",
                "https://github.com/me/shop-mirror.git"
            ]
        );
        assert_eq!(remotes[1].urls, ["git@github.com:acme/shop.git"]);
        assert_eq!(remotes[2].urls, ["https://gitlab.com/acme/old.git"]);
    }

    #[test]
    fn parse_remotes_rong() {
        assert!(parse_remotes("").is_empty());
        assert!(parse_remotes("[core]\n\tbare = false\n").is_empty());
    }

    #[test]
    fn parse_head_nhanh_va_detached() {
        assert_eq!(
            parse_head("ref: refs/heads/main\n").as_deref(),
            Some("main")
        );
        assert_eq!(
            parse_head("ref: refs/heads/feat/m1.4-scope\n").as_deref(),
            Some("feat/m1.4-scope")
        );
        assert_eq!(
            parse_head("3f2a9c0e1b7d4a6f8e2c5b9d0a1f3e7c6b8d2a4f\n"),
            None
        );
    }

    #[test]
    fn cwd_tuong_doi_khong_phai_repo() {
        assert_eq!(find_repo(Path::new("relative/dir")), None);
    }
}
