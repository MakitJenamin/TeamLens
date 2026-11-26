//! Bước lọc phạm vi của pipeline (spec 6.1) — task M1.4, được M1.7 dùng.
//!
//! Ghép phần đọc git ([`super::git`]) với logic khớp pattern thuần
//! ([`tl_core::scope`]). Đây là chốt chặn quyền riêng tư: session không khớp không bao
//! giờ đi tiếp tới bước che secret, hàng đợi hay payload.
//!
//! # Cách dùng (M1.7)
//!
//! ```no_run
//! # use std::path::{Path, PathBuf};
//! # use teamlens::api_client::WhoamiResponse;
//! use teamlens::pipeline::scope::{patterns_from_whoami, ScopeFilter};
//!
//! # fn demo(whoami: &WhoamiResponse, sessions: Vec<(String, PathBuf)>) {
//! let mut filter = ScopeFilter::new(patterns_from_whoami(whoami));
//! // `sessions`: bất kỳ kiểu nào, chỉ cần lấy được `cwd` lúc bắt đầu session.
//! let kept = filter.filter(sessions, |(_, cwd)| Some(cwd.as_path()));
//! for scoped in kept {
//!     // scoped.scope.matched.project_id, scoped.scope.matched.repo_remote,
//!     // scoped.scope.repo_root (để tính cwd_relative), scoped.scope.branch
//!     let _ = scoped.item;
//! }
//! # }
//! ```

use std::path::{Path, PathBuf};

use tl_core::scope::{RepoPatterns, ScopeDecision, ScopeMatch};

use super::git::RepoResolver;
use crate::api_client::WhoamiResponse;

/// Dựng tập pattern từ `GET /agent/v1/whoami` (`projects[].repoPatterns`), giữ thứ tự
/// project của server. Pattern không hợp lệ bị bỏ qua.
pub fn patterns_from_whoami(whoami: &WhoamiResponse) -> RepoPatterns {
    let mut patterns = RepoPatterns::new();
    for project in &whoami.projects {
        for pattern in &project.repo_patterns {
            if !patterns.add(project.id.clone(), pattern) {
                tracing::debug!(project = %project.id, pattern, "bỏ qua repo pattern không hợp lệ");
            }
        }
    }
    patterns
}

/// Thông tin phạm vi của một session đã được giữ lại.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoScope {
    /// Project, remote đã chuẩn hóa (`repo_remote` của payload) và pattern đã khớp.
    pub matched: ScopeMatch,
    /// Gốc working tree, để đổi `cwd` tuyệt đối thành `cwd_relative` (không gửi `cwd`).
    pub repo_root: PathBuf,
    /// Nhánh lúc đọc (trường `branch` của payload); `None` khi detached HEAD.
    pub branch: Option<String>,
}

/// Một phần tử (session) đã qua lọc, kèm phạm vi của nó.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scoped<T> {
    pub item: T,
    pub scope: RepoScope,
}

/// Bộ lọc phạm vi: pattern của user + cache đọc git theo đường dẫn.
#[derive(Debug, Default)]
pub struct ScopeFilter {
    patterns: RepoPatterns,
    resolver: RepoResolver,
}

impl ScopeFilter {
    pub fn new(patterns: RepoPatterns) -> Self {
        Self {
            patterns,
            resolver: RepoResolver::new(),
        }
    }

    /// Thay pattern (sau khi tải lại `whoami` mỗi 1 giờ) và xóa cache git.
    pub fn set_patterns(&mut self, patterns: RepoPatterns) {
        self.patterns = patterns;
        self.resolver.clear();
    }

    /// Quyết định cho một `cwd` (lúc bắt đầu session, spec 6.1 bước 4).
    ///
    /// `None` = ngoài phạm vi: `cwd` thiếu/không tuyệt đối, không phải git repo,
    /// không có remote, hoặc không remote nào khớp pattern. Khi đó caller phải bỏ
    /// session hoàn toàn.
    pub fn scope_of(&mut self, cwd: Option<&Path>) -> Option<RepoScope> {
        if self.patterns.is_empty() {
            return None;
        }
        let repo = self.resolver.resolve(cwd?)?;
        match self.patterns.decide(repo.remote_urls()) {
            ScopeDecision::InScope(matched) => Some(RepoScope {
                matched,
                repo_root: repo.root.clone(),
                branch: repo.branch.clone(),
            }),
            ScopeDecision::OutOfScope => None,
        }
    }

    /// Lọc danh sách: chỉ giữ phần tử trong phạm vi, phần tử ngoài phạm vi bị bỏ hẳn
    /// (không đếm, không log nội dung). Giữ nguyên thứ tự.
    pub fn filter<T, I, F>(&mut self, items: I, cwd_of: F) -> Vec<Scoped<T>>
    where
        I: IntoIterator<Item = T>,
        F: Fn(&T) -> Option<&Path>,
    {
        let mut kept = Vec::new();
        for item in items {
            if let Some(scope) = self.scope_of(cwd_of(&item)) {
                kept.push(Scoped { item, scope });
            }
        }
        kept
    }
}
