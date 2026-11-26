//! Test lọc phạm vi (spec 6.1, task M1.4) với repo giả trong thư mục tạm.
//!
//! Điểm chính: "session ngoài phạm vi không bao giờ vào payload" — đầu ra của
//! `ScopeFilter::filter` chỉ chứa session khớp pattern.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use teamlens::api_client::{WhoamiDevice, WhoamiProject, WhoamiResponse, WhoamiUser};
use teamlens::pipeline::git::find_repo;
use teamlens::pipeline::scope::{patterns_from_whoami, ScopeFilter};

fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

/// Tạo repo giả: `<root>/.git/{config,HEAD}`.
fn fake_repo(root: &Path, remotes: &[(&str, &str)], branch: &str) {
    let mut config = String::from("[core]\n\trepositoryformatversion = 0\n");
    for (name, url) in remotes {
        config.push_str(&format!(
            "[remote \"{name}\"]\n\turl = {url}\n\tfetch = +refs/heads/*:refs/remotes/{name}/*\n"
        ));
    }
    write(&root.join(".git/config"), &config);
    write(
        &root.join(".git/HEAD"),
        &format!("ref: refs/heads/{branch}\n"),
    );
}

fn whoami() -> WhoamiResponse {
    WhoamiResponse {
        user: WhoamiUser {
            id: "u1".into(),
            email: Some("member@example.invalid".into()),
            name: "Member 1".into(),
        },
        role: "member".into(),
        device: WhoamiDevice {
            id: "d1".into(),
            name: "LAPTOP-01".into(),
        },
        projects: vec![
            WhoamiProject {
                id: "proj-acme".into(),
                name: "Acme".into(),
                slug: "acme".into(),
                repo_patterns: vec!["github.com/acme/*".into(), "github.com/acme/*/*".into()],
            },
            WhoamiProject {
                id: "proj-shop".into(),
                name: "Shop".into(),
                slug: "shop".into(),
                repo_patterns: vec!["github.com/acme/shop-api".into()],
            },
        ],
    }
}

#[test]
fn patterns_tu_whoami_bo_pattern_hong() {
    let patterns = patterns_from_whoami(&whoami());
    let list: Vec<(&str, &str)> = patterns
        .patterns()
        .iter()
        .map(|p| (p.project_id.as_str(), p.pattern.as_str()))
        .collect();
    assert_eq!(
        list,
        [
            ("proj-acme", "github.com/acme/*"),
            ("proj-shop", "github.com/acme/shop-api")
        ]
    );
}

#[test]
fn tim_repo_tu_thu_muc_con() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("web");
    fake_repo(&root, &[("origin", "git@github.com:Acme/Web.git")], "main");
    let deep = root.join("src/components/button");
    fs::create_dir_all(&deep).unwrap();

    let repo = find_repo(&deep).expect("phải tìm thấy repo");
    assert_eq!(repo.root, root);
    assert_eq!(repo.branch.as_deref(), Some("main"));
    assert_eq!(
        repo.remote_urls().collect::<Vec<_>>(),
        ["git@github.com:Acme/Web.git"]
    );
}

#[test]
fn worktree_gia_doc_config_chung() {
    let tmp = tempfile::tempdir().unwrap();
    let main = tmp.path().join("main");
    fake_repo(
        &main,
        &[("origin", "https://github.com/acme/web.git")],
        "main",
    );
    // .git/worktrees/wt có commondir trỏ về .git chính và HEAD riêng.
    let wt_gitdir = main.join(".git/worktrees/wt");
    write(&wt_gitdir.join("commondir"), "../..\n");
    write(&wt_gitdir.join("HEAD"), "ref: refs/heads/feat/x\n");
    let wt = tmp.path().join("wt");
    write(
        &wt.join(".git"),
        &format!("gitdir: {}\n", wt_gitdir.display()),
    );

    let repo = find_repo(&wt).expect("worktree phải được nhận");
    assert_eq!(repo.root, wt);
    assert_eq!(repo.branch.as_deref(), Some("feat/x"));
    assert_eq!(
        repo.remote_urls().collect::<Vec<_>>(),
        ["https://github.com/acme/web.git"]
    );
}

#[test]
fn submodule_gia_gitdir_tuong_doi() {
    let tmp = tempfile::tempdir().unwrap();
    let sup = tmp.path().join("super");
    fake_repo(
        &sup,
        &[("origin", "https://github.com/other/super.git")],
        "main",
    );
    let module_dir = sup.join(".git/modules/libs/core");
    write(
        &module_dir.join("config"),
        "[remote \"origin\"]\n\turl = https://github.com/acme/core.git\n",
    );
    write(
        &module_dir.join("HEAD"),
        "0123456789abcdef0123456789abcdef01234567\n",
    );
    let sub = sup.join("libs/core");
    write(&sub.join(".git"), "gitdir: ../../.git/modules/libs/core\n");

    let repo = find_repo(&sub.join("src")).expect("submodule phải được nhận");
    assert_eq!(repo.root, sub);
    assert_eq!(repo.branch, None, "detached HEAD");
    assert_eq!(
        repo.remote_urls().collect::<Vec<_>>(),
        ["https://github.com/acme/core.git"]
    );
}

/// Kiểu session tối giản cho test (M1.2 định nghĩa kiểu thật).
#[derive(Debug, Clone, PartialEq, Eq)]
struct FakeSession {
    id: &'static str,
    cwd: Option<PathBuf>,
}

#[test]
fn session_ngoai_pham_vi_khong_bao_gio_vao_payload() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path();

    // Trong phạm vi.
    let web = base.join("web");
    fake_repo(&web, &[("origin", "git@github.com:acme/web.git")], "main");
    let shop = base.join("shop-api");
    fake_repo(
        &shop,
        &[
            ("origin", "https://github.com/me/shop-api.git"),
            ("upstream", "https://github.com/acme/shop-api.git"),
        ],
        "dev",
    );
    // Ngoài phạm vi.
    let personal = base.join("personal");
    fake_repo(
        &personal,
        &[("origin", "https://github.com/me/blog.git")],
        "main",
    );
    let no_remote = base.join("no-remote");
    fake_repo(&no_remote, &[], "main");
    let local_remote = base.join("local-remote");
    fake_repo(&local_remote, &[("origin", r"C:\repos\acme\web")], "main");
    let not_git = base.join("not-git");
    fs::create_dir_all(&not_git).unwrap();
    let evil = base.join("evil");
    fake_repo(
        &evil,
        &[("origin", "https://github.com/acme-evil/web.git")],
        "main",
    );

    let sessions = vec![
        FakeSession {
            id: "s-web",
            cwd: Some(web.join("src")),
        },
        FakeSession {
            id: "s-personal",
            cwd: Some(personal.clone()),
        },
        FakeSession {
            id: "s-shop",
            cwd: Some(shop.clone()),
        },
        FakeSession {
            id: "s-no-remote",
            cwd: Some(no_remote),
        },
        FakeSession {
            id: "s-not-git",
            cwd: Some(not_git),
        },
        FakeSession {
            id: "s-no-cwd",
            cwd: None,
        },
        FakeSession {
            id: "s-relative",
            cwd: Some(PathBuf::from("web")),
        },
        FakeSession {
            id: "s-missing",
            cwd: Some(base.join("da-xoa")),
        },
        FakeSession {
            id: "s-local-remote",
            cwd: Some(local_remote),
        },
        FakeSession {
            id: "s-evil",
            cwd: Some(evil),
        },
        FakeSession {
            id: "s-web-2",
            cwd: Some(web.clone()),
        },
    ];

    let mut filter = ScopeFilter::new(patterns_from_whoami(&whoami()));
    let kept = filter.filter(sessions, |s| s.cwd.as_deref());

    let summary: Vec<(&str, &str, &str)> = kept
        .iter()
        .map(|s| {
            (
                s.item.id,
                s.scope.matched.project_id.as_str(),
                s.scope.matched.repo_remote.as_str(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("s-web", "proj-acme", "github.com/acme/web"),
            // origin là fork cá nhân, upstream khớp pattern cụ thể nhất.
            ("s-shop", "proj-shop", "github.com/acme/shop-api"),
            ("s-web-2", "proj-acme", "github.com/acme/web"),
        ]
    );
    assert_eq!(kept[0].scope.repo_root, web);
    assert_eq!(kept[1].scope.branch.as_deref(), Some("dev"));

    // Không có pattern nào → không gì lọt qua.
    let mut empty = ScopeFilter::default();
    let kept = empty.filter(
        vec![FakeSession {
            id: "s-web",
            cwd: Some(web),
        }],
        |s| s.cwd.as_deref(),
    );
    assert!(kept.is_empty());
}

fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
        ])
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .output()
        .expect("chạy git");
    assert!(
        out.status.success(),
        "git {args:?} lỗi: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Repo thật tạo bằng `git init` + `git worktree add` (bỏ qua nếu máy không có git).
#[test]
fn repo_that_bang_git_init_va_worktree() {
    if !git_available() {
        eprintln!("bỏ qua: không có git trong PATH");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let main = tmp.path().join("main");
    fs::create_dir_all(&main).unwrap();
    git(&main, &["init", "-q"]);
    git(
        &main,
        &["remote", "add", "origin", "https://github.com/me/web.git"],
    );
    git(
        &main,
        &["remote", "add", "upstream", "git@github.com:Acme/Web.git"],
    );
    git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let wt = tmp.path().join("wt");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/wt",
            wt.to_str().unwrap(),
        ],
    );

    let repo = find_repo(&main).unwrap();
    assert_eq!(repo.branch.as_deref(), Some("main"));
    let wt_repo = find_repo(&wt).unwrap();
    assert_eq!(wt_repo.root, wt);
    assert_eq!(wt_repo.branch.as_deref(), Some("feat/wt"));
    assert_eq!(
        wt_repo.remote_urls().collect::<Vec<_>>(),
        [
            "https://github.com/me/web.git",
            "git@github.com:Acme/Web.git"
        ]
    );

    let mut filter = ScopeFilter::new(patterns_from_whoami(&whoami()));
    let scope = filter.scope_of(Some(&wt)).expect("worktree trong phạm vi");
    assert_eq!(scope.matched.project_id, "proj-acme");
    assert_eq!(scope.matched.repo_remote, "github.com/acme/web");
}
