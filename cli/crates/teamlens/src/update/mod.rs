//! Tự cập nhật `tl` từ GitHub Releases (task M5.3).
//!
//! Quy ước release (chốt chung M5.1–M5.3): repo `MakitJenamin/TeamLens`, tag `v<semver>`, mỗi
//! release có asset [`ASSET_NAME`] (zip chứa đúng một `tl.exe` ở gốc) và [`SUMS_NAME`]
//! (`<sha256>  <tên file>`). Luồng: tìm bản mới nhất ([`Updater::resolve`]) → so với
//! [`crate::CLI_VERSION`] theo semver → tải `SHA256SUMS` và zip, **kiểm SHA-256 trước khi giải nén**
//! ([`Updater::download_verified`]) → chạy thử `tl.exe --version` của bản mới
//! ([`verify_binary`]) → thay file đang chạy bằng `self_replace` ([`install`]).
//! Lỗi ở bất kỳ bước nào: dừng, bản đang dùng giữ nguyên.
//!
//! Biến môi trường để thử nghiệm offline với server tĩnh local:
//! - [`BASE_URL_ENV`] (`TL_UPDATE_BASE_URL`): thư mục chứa zip và `SHA256SUMS`, thay cho GitHub.
//!   Không gọi GitHub API; phiên bản đích lấy từ [`VERSION_ENV`] hoặc, nếu không đặt, từ đoạn
//!   cuối của URL khi nó là một tag (`.../releases/download/v0.1.1-rc.1`).
//! - [`VERSION_ENV`] (`TL_UPDATE_VERSION`): phiên bản đích, không gọi GitHub API (không có base
//!   URL thì tải từ `https://github.com/<repo>/releases/download/v<version>/`).
//! - [`API_URL_ENV`] (`TL_UPDATE_API_URL`): thay URL `releases/latest` của GitHub API (test).
//!
//! Tự cập nhật trong daemon: [`auto`].

pub mod auto;
pub mod restart;
pub mod sums;
pub mod version;

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::error::AppError;
pub use version::Version;

/// Repo GitHub chứa release của `tl`.
pub const GITHUB_REPO: &str = "MakitJenamin/TeamLens";
/// Zip chứa `tl.exe` (tên không kèm phiên bản).
pub const ASSET_NAME: &str = "tl-x86_64-pc-windows-msvc.zip";
/// File checksum của release.
pub const SUMS_NAME: &str = "SHA256SUMS";
/// Tên file thực thi trong zip.
pub const EXE_NAME: &str = "tl.exe";

/// Thay base URL tải asset (thư mục chứa zip và `SHA256SUMS`).
pub const BASE_URL_ENV: &str = "TL_UPDATE_BASE_URL";
/// Phiên bản đích, bỏ qua GitHub API.
pub const VERSION_ENV: &str = "TL_UPDATE_VERSION";
/// Thay URL GitHub API `releases/latest` (test).
pub const API_URL_ENV: &str = "TL_UPDATE_API_URL";

/// Giới hạn kích thước zip tải về.
pub const MAX_ZIP_BYTES: usize = 64 << 20;
/// Giới hạn kích thước `SHA256SUMS` và JSON của GitHub API.
const MAX_TEXT_BYTES: usize = 1 << 20;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/// Lỗi khi cập nhật. Thông điệp tiếng Việt, không chứa token hay nội dung prompt.
#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("Không kết nối được tới {what}: {detail}")]
    Network { what: String, detail: String },
    #[error("Tải {what} lỗi HTTP {status}")]
    Http { what: String, status: u16 },
    #[error("Chưa có bản phát hành chính thức nào trên GitHub")]
    NoRelease,
    #[error("Phiên bản phát hành không hợp lệ: {0}")]
    BadVersion(String),
    #[error("Bản phát hành {version} thiếu file {file}")]
    MissingAsset { version: String, file: String },
    #[error("SHA256SUMS không có dòng cho {0}")]
    MissingSum(String),
    #[error("{file} tải về không khớp SHA256SUMS (mong đợi {expected}, nhận {actual})")]
    ChecksumMismatch {
        file: String,
        expected: String,
        actual: String,
    },
    #[error("{what} lớn quá giới hạn {limit} byte")]
    TooLarge { what: String, limit: usize },
    #[error("Không giải nén được {EXE_NAME} từ {ASSET_NAME}: {0}")]
    Extract(String),
    #[error("Bản tải về không chạy được hoặc sai phiên bản: {0}")]
    BadBinary(String),
    #[error("Không thay được file tl.exe đang chạy: {0}")]
    Install(String),
    #[error("Lỗi đọc/ghi file tạm khi cập nhật: {0}")]
    Io(String),
    #[error("{0}")]
    Config(String),
}

impl UpdateError {
    /// Lỗi tiếng Việt cho người dùng (`tl update`).
    pub fn into_app_error(self) -> AppError {
        let hint = match &self {
            UpdateError::Network { .. } | UpdateError::Http { .. } => {
                "Kiểm tra kết nối mạng (cần truy cập github.com) rồi chạy lại `tl update`."
            }
            UpdateError::ChecksumMismatch { .. } | UpdateError::BadBinary(_) => {
                "Chưa cài gì, bản tl đang dùng giữ nguyên. Thử lại sau; nếu vẫn lỗi, báo leader."
            }
            UpdateError::Install(_) => {
                "Bản tl đang dùng giữ nguyên. Kiểm tra quyền ghi thư mục chứa tl.exe rồi thử lại."
            }
            UpdateError::Config(_) => {
                "Xem `tl update --help` về TL_UPDATE_BASE_URL và TL_UPDATE_VERSION."
            }
            _ => "Bản tl đang dùng giữ nguyên. Thử lại sau; nếu vẫn lỗi, báo leader.",
        };
        AppError::user(self.to_string(), hint)
    }
}

/// Nơi tìm bản phát hành.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateSource {
    /// URL GitHub API `releases/latest`.
    pub api_url: String,
    /// Thư mục chứa asset, thay cho GitHub (`TL_UPDATE_BASE_URL`).
    pub base_url: Option<String>,
    /// Phiên bản đích (`TL_UPDATE_VERSION`).
    pub version: Option<String>,
}

impl Default for UpdateSource {
    fn default() -> Self {
        Self {
            api_url: format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest"),
            base_url: None,
            version: None,
        }
    }
}

impl UpdateSource {
    /// Đọc override từ biến môi trường.
    pub fn from_env() -> Self {
        Self::from_vars(|k| std::env::var(k).ok())
    }

    /// Như [`Self::from_env`] nhưng nhận hàm đọc biến (để test).
    pub fn from_vars(get: impl Fn(&str) -> Option<String>) -> Self {
        let get = |k: &str| {
            get(k)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let mut s = Self::default();
        if let Some(api) = get(API_URL_ENV) {
            s.api_url = api;
        }
        s.base_url = get(BASE_URL_ENV).map(|b| b.trim_end_matches('/').to_owned());
        s.version = get(VERSION_ENV);
        s
    }
}

/// Một bản phát hành đã xác định được.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub version: Version,
    pub zip_url: String,
    pub sums_url: String,
}

/// Kết quả kiểm tra bản mới.
#[derive(Debug, Clone)]
pub struct Check {
    pub current: Version,
    pub latest: Release,
}

impl Check {
    /// Bản phát hành mới hơn bản đang chạy?
    pub fn newer(&self) -> bool {
        self.latest.version > self.current
    }
}

/// Asset trong JSON của GitHub API.
#[derive(Debug, Clone, Deserialize)]
pub struct GhAsset {
    pub name: String,
    pub browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

/// Chọn asset theo tên chính xác.
pub fn select_asset<'a>(assets: &'a [GhAsset], name: &str) -> Option<&'a GhAsset> {
    assets.iter().find(|a| a.name == name)
}

/// Phiên bản đang chạy.
pub fn current_version() -> Version {
    Version::parse(crate::CLI_VERSION).expect("CARGO_PKG_VERSION luôn là semver")
}

/// Tìm, tải và kiểm bản phát hành.
#[derive(Debug, Clone)]
pub struct Updater {
    http: reqwest::Client,
    pub source: UpdateSource,
}

impl Updater {
    pub fn new(source: UpdateSource) -> Result<Self, UpdateError> {
        let http = reqwest::Client::builder()
            .user_agent(crate::user_agent())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| UpdateError::Config(format!("Không tạo được HTTP client: {e}")))?;
        Ok(Self { http, source })
    }

    /// Updater theo biến môi trường của máy.
    pub fn from_env() -> Result<Self, UpdateError> {
        Self::new(UpdateSource::from_env())
    }

    /// Xác định bản phát hành đích (xem tài liệu module về biến môi trường).
    pub async fn resolve(&self) -> Result<Release, UpdateError> {
        let s = &self.source;
        let explicit = match (&s.version, &s.base_url) {
            (Some(v), _) => Some(v.clone()),
            (None, Some(base)) => {
                let last = base.rsplit('/').next().unwrap_or_default();
                if Version::parse(last).is_none() {
                    return Err(UpdateError::Config(format!(
                        "Đặt {BASE_URL_ENV} mà không đặt {VERSION_ENV}: cần đoạn cuối của URL là tag phiên bản (ví dụ .../v0.2.0), URL hiện tại: {base}"
                    )));
                }
                Some(last.to_owned())
            }
            (None, None) => None,
        };
        if let Some(text) = explicit {
            let version =
                Version::parse(&text).ok_or_else(|| UpdateError::BadVersion(text.clone()))?;
            let base = s.base_url.clone().unwrap_or_else(|| {
                format!("https://github.com/{GITHUB_REPO}/releases/download/v{version}")
            });
            return Ok(Release {
                version,
                zip_url: format!("{base}/{ASSET_NAME}"),
                sums_url: format!("{base}/{SUMS_NAME}"),
            });
        }

        let body = self
            .get_bytes(
                &s.api_url,
                "thông tin bản phát hành (GitHub API)",
                MAX_TEXT_BYTES,
                Some("application/vnd.github+json"),
            )
            .await
            .map_err(|e| match e {
                UpdateError::Http { status: 404, .. } => UpdateError::NoRelease,
                e => e,
            })?;
        let gh: GhRelease = serde_json::from_slice(&body).map_err(|e| UpdateError::Network {
            what: "GitHub API".into(),
            detail: format!("phản hồi không hợp lệ ({e})"),
        })?;
        let version = Version::parse(&gh.tag_name)
            .ok_or_else(|| UpdateError::BadVersion(gh.tag_name.clone()))?;
        let url_of = |name: &str| {
            select_asset(&gh.assets, name)
                .map(|a| a.browser_download_url.clone())
                .ok_or_else(|| UpdateError::MissingAsset {
                    version: version.to_string(),
                    file: name.to_owned(),
                })
        };
        Ok(Release {
            zip_url: url_of(ASSET_NAME)?,
            sums_url: url_of(SUMS_NAME)?,
            version,
        })
    }

    /// Tìm bản mới nhất và so với bản đang chạy.
    pub async fn check(&self) -> Result<Check, UpdateError> {
        Ok(Check {
            current: current_version(),
            latest: self.resolve().await?,
        })
    }

    async fn get_bytes(
        &self,
        url: &str,
        what: &str,
        limit: usize,
        accept: Option<&str>,
    ) -> Result<Vec<u8>, UpdateError> {
        let network = |e: reqwest::Error| UpdateError::Network {
            what: what.to_owned(),
            detail: e.without_url().to_string(),
        };
        let mut req = self.http.get(url);
        if let Some(a) = accept {
            req = req.header(reqwest::header::ACCEPT, a);
        }
        let mut resp = req.send().await.map_err(network)?;
        let status = resp.status();
        if !status.is_success() {
            return Err(UpdateError::Http {
                what: what.to_owned(),
                status: status.as_u16(),
            });
        }
        let too_large = || UpdateError::TooLarge {
            what: what.to_owned(),
            limit,
        };
        if resp.content_length().is_some_and(|n| n > limit as u64) {
            return Err(too_large());
        }
        let mut data = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(network)? {
            if data.len() + chunk.len() > limit {
                return Err(too_large());
            }
            data.extend_from_slice(&chunk);
        }
        Ok(data)
    }

    /// Tải `SHA256SUMS` và zip vào `dir`, kiểm SHA-256 **trước** khi giải nén, rồi giải nén
    /// `tl.exe`. Trả đường dẫn `tl.exe` mới (trong `dir`). Hash sai thì không ghi zip ra đĩa.
    pub async fn download_verified(
        &self,
        release: &Release,
        dir: &Path,
    ) -> Result<PathBuf, UpdateError> {
        let sums = self
            .get_bytes(&release.sums_url, SUMS_NAME, MAX_TEXT_BYTES, None)
            .await?;
        let sums = String::from_utf8_lossy(&sums);
        let expected = sums::expected_for(&sums, ASSET_NAME)
            .ok_or_else(|| UpdateError::MissingSum(ASSET_NAME.to_owned()))?;
        let zip = self
            .get_bytes(&release.zip_url, ASSET_NAME, MAX_ZIP_BYTES, None)
            .await?;
        let actual = sums::sha256_hex(&zip);
        if actual != expected {
            return Err(UpdateError::ChecksumMismatch {
                file: ASSET_NAME.to_owned(),
                expected,
                actual,
            });
        }
        let zip_path = dir.join(ASSET_NAME);
        std::fs::write(&zip_path, &zip).map_err(|e| UpdateError::Io(e.to_string()))?;
        extract_exe(&zip_path, dir)
    }
}

/// Giải nén `tl.exe` ở gốc zip vào `dir`.
pub fn extract_exe(zip_path: &Path, dir: &Path) -> Result<PathBuf, UpdateError> {
    self_update::Extract::from_source(zip_path)
        .archive(self_update::ArchiveKind::Zip)
        .extract_file(dir, EXE_NAME)
        .map_err(|e| UpdateError::Extract(e.to_string()))?;
    let exe = dir.join(EXE_NAME);
    match std::fs::metadata(&exe) {
        Ok(m) if m.is_file() && m.len() > 0 => Ok(exe),
        _ => Err(UpdateError::Extract(format!(
            "{EXE_NAME} rỗng hoặc không có"
        ))),
    }
}

/// Chạy `<exe> --version` và đối chiếu với phiên bản mong đợi (bắt file hỏng, nhầm bản).
pub fn verify_binary(exe: &Path, expected: &Version) -> Result<(), UpdateError> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .env_remove("TL_LOG");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Daemon chạy ẩn: không bật cửa sổ console cho tiến trình con.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| UpdateError::BadBinary(format!("không chạy được ({e})")))?;
    if !out.status.success() {
        return Err(UpdateError::BadBinary(format!(
            "`tl --version` thoát với {}",
            out.status
        )));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let got = text.split_whitespace().last().and_then(Version::parse);
    match got {
        Some(v) if &v == expected => Ok(()),
        _ => Err(UpdateError::BadBinary(format!(
            "mong đợi tl {expected}, bản tải về báo `{}`",
            text.trim()
        ))),
    }
}

/// Thay file thực thi đang chạy bằng `new_exe` (an toàn khi đang chạy trên Windows).
pub fn install(new_exe: &Path) -> Result<(), UpdateError> {
    self_replace::self_replace(new_exe).map_err(|e| UpdateError::Install(e.to_string()))
}

/// Thư mục tạm cho một lần cập nhật, trong thư mục dữ liệu (cùng ổ đĩa, tự xóa khi drop).
pub fn work_dir(data_dir: &Path) -> Result<tempfile::TempDir, UpdateError> {
    std::fs::create_dir_all(data_dir).map_err(|e| UpdateError::Io(e.to_string()))?;
    tempfile::Builder::new()
        .prefix("update-")
        .tempdir_in(data_dir)
        .map_err(|e| UpdateError::Io(e.to_string()))
}

/// Cả luồng sau khi đã biết bản đích: tải + kiểm hash → chạy thử → thay file.
pub async fn download_and_install(
    updater: &Updater,
    release: &Release,
    data_dir: &Path,
) -> Result<(), UpdateError> {
    let dir = work_dir(data_dir)?;
    let new_exe = updater.download_verified(release, dir.path()).await?;
    verify_binary(&new_exe, &release.version)?;
    install(&new_exe)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> UpdateSource {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        UpdateSource::from_vars(|k| map.get(k).cloned())
    }

    #[test]
    fn nguon_mac_dinh_la_github() {
        let s = vars(&[]);
        assert_eq!(
            s.api_url,
            "https://api.github.com/repos/MakitJenamin/TeamLens/releases/latest"
        );
        assert_eq!(s.base_url, None);
        assert_eq!(s.version, None);
        let s = vars(&[(BASE_URL_ENV, "  "), (VERSION_ENV, "")]);
        assert_eq!(s, UpdateSource::default(), "biến rỗng coi như không đặt");
    }

    #[tokio::test]
    async fn version_env_khong_goi_api() {
        let u = Updater::new(vars(&[(VERSION_ENV, "v0.2.0")])).unwrap();
        let r = u.resolve().await.unwrap();
        assert_eq!(r.version.to_string(), "0.2.0");
        assert_eq!(
            r.zip_url,
            "https://github.com/MakitJenamin/TeamLens/releases/download/v0.2.0/tl-x86_64-pc-windows-msvc.zip"
        );
        assert!(r.sums_url.ends_with("/v0.2.0/SHA256SUMS"));
    }

    #[tokio::test]
    async fn base_url_doc_phien_ban_tu_tag() {
        let u = Updater::new(vars(&[(
            BASE_URL_ENV,
            "http://127.0.0.1:8000/releases/download/v0.1.1-rc.1/",
        )]))
        .unwrap();
        let r = u.resolve().await.unwrap();
        assert_eq!(r.version.to_string(), "0.1.1-rc.1");
        assert_eq!(
            r.zip_url,
            "http://127.0.0.1:8000/releases/download/v0.1.1-rc.1/tl-x86_64-pc-windows-msvc.zip"
        );

        let u = Updater::new(vars(&[
            (BASE_URL_ENV, "http://127.0.0.1:8000/dist"),
            (VERSION_ENV, "0.3.0"),
        ]))
        .unwrap();
        let r = u.resolve().await.unwrap();
        assert_eq!(r.version.to_string(), "0.3.0");
        assert_eq!(r.sums_url, "http://127.0.0.1:8000/dist/SHA256SUMS");

        let u = Updater::new(vars(&[(BASE_URL_ENV, "http://127.0.0.1:8000/dist")])).unwrap();
        assert!(matches!(u.resolve().await, Err(UpdateError::Config(_))));
        let u = Updater::new(vars(&[(VERSION_ENV, "moi-nhat")])).unwrap();
        assert!(matches!(u.resolve().await, Err(UpdateError::BadVersion(_))));
    }

    #[test]
    fn chon_asset_dung_ten() {
        let assets = vec![
            GhAsset {
                name: "SHA256SUMS".into(),
                browser_download_url: "u1".into(),
            },
            GhAsset {
                name: "tl-x86_64-pc-windows-msvc.zip.sig".into(),
                browser_download_url: "u2".into(),
            },
            GhAsset {
                name: ASSET_NAME.into(),
                browser_download_url: "u3".into(),
            },
        ];
        assert_eq!(
            select_asset(&assets, ASSET_NAME)
                .unwrap()
                .browser_download_url,
            "u3"
        );
        assert_eq!(
            select_asset(&assets, SUMS_NAME)
                .unwrap()
                .browser_download_url,
            "u1"
        );
        assert!(select_asset(&assets, "tl-aarch64-pc-windows-msvc.zip").is_none());
    }

    #[test]
    fn so_voi_ban_dang_chay() {
        let current = current_version();
        let mk = |v: &str| Check {
            current: current.clone(),
            latest: Release {
                version: Version::parse(v).unwrap(),
                zip_url: String::new(),
                sums_url: String::new(),
            },
        };
        assert!(!mk(crate::CLI_VERSION).newer());
        assert!(mk("999.0.0").newer());
        assert!(!mk("0.0.1").newer());
    }

    #[test]
    fn loi_sha_sai_co_goi_y_giu_ban_cu() {
        let e = UpdateError::ChecksumMismatch {
            file: ASSET_NAME.into(),
            expected: "aa".into(),
            actual: "bb".into(),
        }
        .into_app_error();
        assert!(e.to_string().contains("không khớp SHA256SUMS"));
        assert!(e.hint().unwrap().contains("giữ nguyên"));
    }
}
