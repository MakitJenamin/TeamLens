//! Lọc phạm vi theo git remote (spec mục 6.1) — task M1.4.
//!
//! Module này là logic thuần (không đọc file, không gọi `git`): chuẩn hóa remote URL
//! và so khớp với repo pattern của các project (`host/org/repo` hoặc `host/org/*`).
//! Phần đọc remote từ đĩa nằm ở `teamlens::pipeline::git`, phần lọc danh sách
//! session ở `teamlens::pipeline::scope`.
//!
//! Lời hứa quyền riêng tư: session không khớp pattern nào (hoặc không ở trong git repo)
//! bị bỏ **hoàn toàn**, không gửi cả metadata hay số đếm. Mọi chỗ không chắc chắn
//! (URL lạ, pattern hỏng) đều nghiêng về phía "ngoài phạm vi".
//!
//! # Cách dùng (cho task M1.7)
//!
//! ```
//! use tl_core::scope::{RepoPatterns, ScopeDecision};
//!
//! let mut patterns = RepoPatterns::new();
//! patterns.add("project-a", "github.com/acme/*");
//! patterns.add("project-b", "https://github.com/acme/shop-api.git");
//!
//! // Mọi remote của repo (origin, upstream, ...), theo thứ tự ưu tiên.
//! let remotes = ["git@github.com:Acme/Shop-API.git"];
//! match patterns.decide(remotes) {
//!     ScopeDecision::InScope(m) => {
//!         // Pattern cụ thể nhất thắng: project-b.
//!         assert_eq!(m.project_id, "project-b");
//!         assert_eq!(m.repo_remote, "github.com/acme/shop-api");
//!     }
//!     ScopeDecision::OutOfScope => unreachable!(),
//! }
//! ```

/// Chuẩn hóa remote git của một repo về dạng `host/org/repo`.
///
/// Khớp hành vi `normalizeRemotePattern` phía server
/// (`apps/api/src/common/remote-pattern.ts`):
/// - chữ thường, bỏ khoảng trắng hai đầu;
/// - bỏ scheme (`https://`, `http://`, `ssh://`, `git://`, `git+ssh://`, ...);
/// - bỏ phần user (`git@`, `user@`, `user:pass@`);
/// - URL có scheme: bỏ cổng (`host:2222/org/repo` → `host/org/repo`);
/// - dạng scp (`git@host:org/repo`): đổi `host:org` thành `host/org`
///   (org toàn số vẫn là org, không phải cổng);
/// - bỏ `/` và `.git` ở cuối.
///
/// Trả về `None` nếu kết quả không đúng dạng `host/org/repo` (ví dụ remote là đường
/// dẫn trên đĩa, `file://`, hoặc GitLab subgroup `host/a/b/c` — server cũng không
/// nhận pattern dạng đó nên không thể khớp). Khác với pattern, remote không được
/// chứa `*`.
pub fn normalize_remote(input: &str) -> Option<String> {
    let normalized = normalize_inner(input)?;
    if normalized.ends_with("/*") {
        return None;
    }
    Some(normalized)
}

/// Chuẩn hóa repo pattern của project: như [`normalize_remote`] nhưng cho phép
/// phần repo là `*` (`host/org/*`).
///
/// Server đã chuẩn hóa pattern khi lưu, hàm này chạy lại phía CLI để phòng dữ liệu cũ
/// hoặc server khác phiên bản. Trả về `None` nếu pattern không hợp lệ.
pub fn normalize_pattern(input: &str) -> Option<String> {
    normalize_inner(input)
}

fn normalize_inner(input: &str) -> Option<String> {
    let mut value: &str = input.trim();
    if value.is_empty() {
        return None;
    }
    let lowered = value.to_lowercase();
    value = &lowered;

    // Bỏ scheme: `[a-z][a-z0-9+.-]*://`.
    let mut has_scheme = false;
    if let Some(idx) = value.find("://") {
        let scheme = &value[..idx];
        let mut chars = scheme.chars();
        let valid = chars.next().is_some_and(|c| c.is_ascii_lowercase())
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "+.-".contains(c));
        if valid {
            has_scheme = true;
            value = &value[idx + 3..];
        }
    }

    // Bỏ phần user: `^[^@/]+@`.
    if let Some(at) = value.find('@') {
        if at > 0 && !value[..at].contains('/') {
            value = &value[at + 1..];
        }
    }

    let mut owned = value.to_string();
    if let Some(colon) = owned.find(':') {
        let host = &owned[..colon];
        let host_ok = !host.is_empty() && !host.contains('/');
        if host_ok {
            if has_scheme {
                // `host:2222/org/repo` → bỏ cổng.
                let rest = &owned[colon + 1..];
                if let Some(slash) = rest.find('/') {
                    let port = &rest[..slash];
                    if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
                        owned = format!("{host}/{}", &rest[slash + 1..]);
                    }
                }
            } else {
                // Dạng scp: `host:org/repo` → `host/org/repo`.
                owned = format!("{host}/{}", &owned[colon + 1..]);
            }
        }
    }

    // Bỏ `/` cuối, `.git` cuối, rồi `/` cuối lần nữa.
    let mut trimmed = owned.trim_end_matches('/');
    if let Some(stripped) = trimmed.strip_suffix(".git") {
        trimmed = stripped;
    }
    let trimmed = trimmed.trim_end_matches('/');

    let parts: Vec<&str> = trimmed.split('/').collect();
    let [host, org, repo] = parts.as_slice() else {
        return None;
    };
    if !is_valid_host(host) || !is_valid_segment(org) {
        return None;
    }
    if *repo != "*" && !is_valid_segment(repo) {
        return None;
    }
    Some(format!("{host}/{org}/{repo}"))
}

/// `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`
fn is_valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.split('.').all(|label| {
            let bytes = label.as_bytes();
            !bytes.is_empty()
                && bytes
                    .iter()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
                && bytes[0] != b'-'
                && bytes[bytes.len() - 1] != b'-'
        })
}

/// `^[a-z0-9._-]+$`, khác `.` và `..`.
fn is_valid_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

/// Độ cụ thể của pattern. So sánh được: `Exact > Wildcard`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Specificity {
    /// `host/org/*`
    Wildcard,
    /// `host/org/repo`
    Exact,
}

/// Một pattern đã chuẩn hóa, gắn với project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoPattern {
    pub project_id: String,
    /// Dạng chuẩn hóa: `host/org/repo` hoặc `host/org/*`.
    pub pattern: String,
}

impl RepoPattern {
    /// Độ cụ thể của pattern.
    pub fn specificity(&self) -> Specificity {
        specificity_of(&self.pattern)
    }

    /// `remote` phải là dạng đã chuẩn hóa (kết quả của [`normalize_remote`]).
    fn matches_normalized(&self, remote: &str) -> bool {
        match self.pattern.strip_suffix('*') {
            // `host/org/*`: khớp đúng một segment repo bất kỳ.
            Some(prefix) => remote
                .strip_prefix(prefix)
                .is_some_and(|repo| !repo.is_empty() && !repo.contains('/')),
            None => self.pattern == remote,
        }
    }
}

/// Kết quả khớp: session thuộc project nào, qua remote và pattern nào.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeMatch {
    /// Project sẽ gắn vào session.
    pub project_id: String,
    /// Remote đã chuẩn hóa đã khớp — dùng làm `repo_remote` trong payload session v1.
    pub repo_remote: String,
    /// Pattern (đã chuẩn hóa) đã khớp.
    pub pattern: String,
}

impl ScopeMatch {
    /// Độ cụ thể của pattern đã khớp.
    pub fn specificity(&self) -> Specificity {
        specificity_of(&self.pattern)
    }
}

fn specificity_of(pattern: &str) -> Specificity {
    if pattern.ends_with("/*") {
        Specificity::Wildcard
    } else {
        Specificity::Exact
    }
}

/// Quyết định cho một session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeDecision {
    /// Thuộc phạm vi: xử lý tiếp và gắn `project_id`.
    InScope(ScopeMatch),
    /// Ngoài phạm vi (không phải git repo, không có remote, hoặc không khớp pattern nào):
    /// bỏ hoàn toàn, không gửi gì kể cả metadata.
    OutOfScope,
}

impl ScopeDecision {
    pub fn is_in_scope(&self) -> bool {
        matches!(self, ScopeDecision::InScope(_))
    }
}

/// Tập pattern remote của mọi project mà user là thành viên (lấy từ `GET /agent/v1/whoami`,
/// trường `projects[].repoPatterns`).
///
/// Quy tắc chọn khi nhiều pattern khớp — **pattern cụ thể nhất** thắng, giống ingest
/// phía server (M1.6):
/// 1. pattern chính xác `host/org/repo` thắng `host/org/*`;
/// 2. cùng độ cụ thể: remote đứng trước trong danh sách remote thắng (phía đọc git đưa
///    `origin` lên đầu);
/// 3. vẫn hòa: pattern được thêm trước thắng (thứ tự project trong `whoami`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RepoPatterns {
    entries: Vec<RepoPattern>,
}

impl RepoPatterns {
    pub fn new() -> Self {
        Self::default()
    }

    /// Thêm một pattern cho project. Pattern được chuẩn hóa bằng [`normalize_pattern`];
    /// pattern không hợp lệ bị bỏ qua (trả `false`) — an toàn vì thiếu pattern chỉ làm
    /// ít session được gửi hơn.
    pub fn add(&mut self, project_id: impl Into<String>, pattern: &str) -> bool {
        let Some(pattern) = normalize_pattern(pattern) else {
            return false;
        };
        let project_id = project_id.into();
        let entry = RepoPattern {
            project_id,
            pattern,
        };
        if !self.entries.contains(&entry) {
            self.entries.push(entry);
        }
        true
    }

    /// Các pattern hợp lệ đã thêm, theo thứ tự thêm.
    pub fn patterns(&self) -> &[RepoPattern] {
        &self.entries
    }

    /// `true` nếu chưa có pattern nào: mọi session đều ngoài phạm vi.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Khớp một remote (URL thô hoặc đã chuẩn hóa). Trả pattern cụ thể nhất khớp được,
    /// `None` nếu remote không chuẩn hóa được hoặc không khớp pattern nào.
    pub fn matches(&self, remote: &str) -> Option<ScopeMatch> {
        let remote = normalize_remote(remote)?;
        let mut best: Option<&RepoPattern> = None;
        for entry in &self.entries {
            if entry.matches_normalized(&remote)
                && best.is_none_or(|b| entry.specificity() > b.specificity())
            {
                best = Some(entry);
            }
        }
        best.map(|entry| ScopeMatch {
            project_id: entry.project_id.clone(),
            repo_remote: remote,
            pattern: entry.pattern.clone(),
        })
    }

    /// Quyết định cho một repo có nhiều remote (thứ tự = ưu tiên, `origin` nên đứng đầu).
    /// Danh sách rỗng (không phải git repo / không có remote) → [`ScopeDecision::OutOfScope`].
    pub fn decide<I, S>(&self, remotes: I) -> ScopeDecision
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut best: Option<(Specificity, ScopeMatch)> = None;
        for remote in remotes {
            let Some(found) = self.matches(remote.as_ref()) else {
                continue;
            };
            let spec = found.specificity();
            if best.as_ref().is_none_or(|(b, _)| spec > *b) {
                best = Some((spec, found));
            }
        }
        match best {
            Some((_, found)) => ScopeDecision::InScope(found),
            None => ScopeDecision::OutOfScope,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_khop_server() {
        // Cùng bộ case với apps/api/src/common/remote-pattern.spec.ts.
        let cases = [
            ("github.com/org/repo", "github.com/org/repo"),
            ("https://github.com/Org/Repo.git", "github.com/org/repo"),
            ("https://github.com/org/repo/", "github.com/org/repo"),
            (
                "git@github.com:MakitJenamin/TeamLens.git",
                "github.com/makitjenamin/teamlens",
            ),
            (
                "ssh://git@gitlab.example.com/team/app.git",
                "gitlab.example.com/team/app",
            ),
            (
                "ssh://git@gitlab.example.com:2222/team/app.git",
                "gitlab.example.com/team/app",
            ),
            ("  GitHub.com/ACME/*  ", "github.com/acme/*"),
            ("github.com/acme/*/", "github.com/acme/*"),
            (
                "https://user@bitbucket.org/acme/web.git/",
                "bitbucket.org/acme/web",
            ),
            (
                "github.com/org/my.repo_name-2",
                "github.com/org/my.repo_name-2",
            ),
            ("git@github.com:12345/app.git", "github.com/12345/app"),
            ("github.com:12345/app", "github.com/12345/app"),
            ("https://github.com:443/org/repo.git", "github.com/org/repo"),
        ];
        for (input, expected) in cases {
            assert_eq!(
                normalize_pattern(input).as_deref(),
                Some(expected),
                "input: {input}"
            );
        }
    }

    #[test]
    fn normalize_tu_choi_giong_server() {
        let cases = [
            "",
            "   ",
            "github.com",
            "github.com/org",
            "github.com/*/*",
            "github.com/org/repo/extra",
            "github.com/org/re*po",
            "github.com//repo",
            "*/org/repo",
            "github.com/org/..",
        ];
        for input in cases {
            assert_eq!(normalize_pattern(input), None, "input: {input:?}");
        }
    }

    #[test]
    fn normalize_remote_nhieu_dang_url() {
        let cases = [
            // https có user:pass (token cũ trong URL) → bỏ hết.
            (
                "https://user:ghp_secret@github.com/Acme/Shop.git",
                "github.com/acme/shop",
            ),
            (
                "https://oauth2:tok@gitlab.com/acme/api",
                "gitlab.com/acme/api",
            ),
            (
                "http://GIT.Example.COM/Team/App.git",
                "git.example.com/team/app",
            ),
            ("git://github.com/acme/shop.git", "github.com/acme/shop"),
            (
                "git+ssh://git@github.com/acme/shop.git",
                "github.com/acme/shop",
            ),
            ("ssh://github.com:22/acme/shop", "github.com/acme/shop"),
            ("git@github.com:acme/shop", "github.com/acme/shop"),
            ("git@github.com:acme/shop.git/", "github.com/acme/shop"),
            (
                "  https://github.com/acme/shop.git  ",
                "github.com/acme/shop",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(
                normalize_remote(input).as_deref(),
                Some(expected),
                "input: {input}"
            );
        }
    }

    #[test]
    fn normalize_remote_tu_choi() {
        let cases = [
            // Remote là đường dẫn trên đĩa.
            r"C:\repos\shop",
            "C:/repos/shop",
            "../shop.git",
            "/srv/git/shop.git",
            "file:///C:/repos/shop.git",
            // Pattern wildcard không phải remote.
            "github.com/acme/*",
            // GitLab subgroup: server không nhận pattern dạng này.
            "https://gitlab.com/acme/team/app.git",
            // Azure DevOps ssh có 4 segment.
            "git@ssh.dev.azure.com:v3/acme/project/repo",
            "https://github.com/acme",
            "",
        ];
        for input in cases {
            assert_eq!(normalize_remote(input), None, "input: {input:?}");
        }
    }

    #[test]
    fn normalize_idempotent() {
        for input in [
            "git@github.com:Acme/Shop.git",
            "https://u:p@gitlab.example.com:8443/team/app.git/",
        ] {
            let once = normalize_remote(input).unwrap();
            assert_eq!(normalize_remote(&once).as_deref(), Some(once.as_str()));
        }
    }

    fn sample_patterns() -> RepoPatterns {
        let mut p = RepoPatterns::new();
        assert!(p.add("p-wild", "github.com/acme/*"));
        assert!(p.add("p-exact", "git@github.com:Acme/Shop-API.git"));
        assert!(p.add("p-gitlab", "gitlab.com/acme/billing"));
        assert!(!p.add("p-bad", "github.com/*/*"));
        p
    }

    #[test]
    fn pattern_hong_bi_bo_qua() {
        let p = sample_patterns();
        assert_eq!(p.patterns().len(), 3);
        assert!(p.patterns().iter().all(|e| e.project_id != "p-bad"));
    }

    #[test]
    fn matches_wildcard_va_exact() {
        let p = sample_patterns();
        let m = p.matches("https://github.com/acme/web.git").unwrap();
        assert_eq!(m.project_id, "p-wild");
        assert_eq!(m.repo_remote, "github.com/acme/web");
        assert_eq!(m.pattern, "github.com/acme/*");

        // Cả wildcard và exact đều khớp → exact (cụ thể nhất) thắng.
        let m = p.matches("git@github.com:acme/shop-api.git").unwrap();
        assert_eq!(m.project_id, "p-exact");
        assert_eq!(m.pattern, "github.com/acme/shop-api");

        let m = p.matches("https://gitlab.com/Acme/Billing").unwrap();
        assert_eq!(m.project_id, "p-gitlab");
    }

    #[test]
    fn matches_khong_khop() {
        let p = sample_patterns();
        assert_eq!(p.matches("https://github.com/other/web.git"), None);
        // Wildcard chỉ khớp đúng org, không khớp org có tiền tố giống.
        assert_eq!(p.matches("https://github.com/acme-evil/web.git"), None);
        assert_eq!(p.matches("https://gitlab.com/acme/web.git"), None);
        assert_eq!(p.matches("https://evilgithub.com/acme/web.git"), None);
        assert_eq!(p.matches(r"C:\repos\shop"), None);
    }

    #[test]
    fn decide_khong_co_remote_la_ngoai_pham_vi() {
        let p = sample_patterns();
        assert_eq!(p.decide(Vec::<String>::new()), ScopeDecision::OutOfScope);
        assert_eq!(
            p.decide(["https://github.com/other/x.git"]),
            ScopeDecision::OutOfScope
        );
        assert_eq!(
            RepoPatterns::new().decide(["https://github.com/acme/web.git"]),
            ScopeDecision::OutOfScope
        );
    }

    #[test]
    fn decide_nhieu_remote_chon_cu_the_nhat() {
        let p = sample_patterns();
        // origin là fork cá nhân (không khớp), upstream khớp wildcard.
        let d = p.decide([
            "https://github.com/someone/web.git",
            "https://github.com/acme/web.git",
        ]);
        let ScopeDecision::InScope(m) = d else {
            panic!("phải trong phạm vi")
        };
        assert_eq!(m.project_id, "p-wild");
        assert_eq!(m.repo_remote, "github.com/acme/web");

        // remote đầu khớp wildcard, remote sau khớp exact → exact thắng.
        let d = p.decide([
            "https://github.com/acme/web.git",
            "git@github.com:acme/shop-api.git",
        ]);
        let ScopeDecision::InScope(m) = d else {
            panic!("phải trong phạm vi")
        };
        assert_eq!(m.project_id, "p-exact");
        assert_eq!(m.repo_remote, "github.com/acme/shop-api");

        // Cùng độ cụ thể → remote đứng trước thắng.
        let d = p.decide([
            "https://github.com/acme/first.git",
            "https://github.com/acme/second.git",
        ]);
        let ScopeDecision::InScope(m) = d else {
            panic!("phải trong phạm vi")
        };
        assert_eq!(m.repo_remote, "github.com/acme/first");
    }

    #[test]
    fn hoa_giua_project_chon_project_them_truoc() {
        let mut p = RepoPatterns::new();
        p.add("p1", "github.com/acme/*");
        p.add("p2", "github.com/acme/*");
        let m = p.matches("github.com/acme/web").unwrap();
        assert_eq!(m.project_id, "p1");
    }
}
