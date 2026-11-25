//! Phần phụ thuộc hệ điều hành của TeamLens CLI.
//!
//! Mọi thứ khác trong CLI chỉ dùng trait [`Platform`] và [`CredentialStore`], để sau này
//! thêm macOS/Linux mà không phải sửa logic. MVP chỉ có impl Windows; hệ điều hành khác
//! trả [`PlatformError::Unsupported`].
//!
//! | Chức năng | Trạng thái |
//! | --- | --- |
//! | Thư mục dữ liệu `%LOCALAPPDATA%\teamlens` | xong |
//! | Credential store (Windows Credential Manager qua `keyring`) | xong |
//! | Named mutex (một instance daemon) | xong |
//! | Task Scheduler "At log on" | task B4 |

mod credentials;
#[cfg(windows)]
mod windows_impl;

use std::path::{Path, PathBuf};

pub use credentials::{
    CredentialStore, KeyringCredentialStore, MemoryCredentialStore, KEYRING_SERVICE,
};

/// Tên thư mục dữ liệu của TeamLens trong thư mục dữ liệu local của user.
pub const APP_DIR_NAME: &str = "teamlens";

/// Lỗi từ tầng hệ điều hành. Thông điệp viết tiếng Việt vì có thể hiện cho người dùng.
#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    #[error("{feature} chưa hỗ trợ trên hệ điều hành này (MVP chỉ hỗ trợ Windows 10/11)")]
    Unsupported { feature: &'static str },
    #[error("{feature} chưa làm (thuộc task {task})")]
    NotImplemented {
        feature: &'static str,
        task: &'static str,
    },
    #[error("không xác định được thư mục dữ liệu của người dùng")]
    NoDataDir,
    #[error("lỗi Credential Manager: {0}")]
    Credential(String),
    #[error("lỗi hệ điều hành: {0}")]
    Os(String),
}

/// Giữ named mutex; nhả khi drop. Có được guard nghĩa là đang là instance duy nhất.
pub struct InstanceGuard {
    _inner: Box<dyn Send>,
}

impl InstanceGuard {
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) fn new(inner: Box<dyn Send>) -> Self {
        Self { _inner: inner }
    }
}

impl std::fmt::Debug for InstanceGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("InstanceGuard")
    }
}

/// Các dịch vụ hệ điều hành mà CLI cần.
pub trait Platform: Send + Sync {
    /// Thư mục chứa config, `state.db`, log (`%LOCALAPPDATA%\teamlens` trên Windows).
    /// Không tự tạo thư mục.
    fn data_dir(&self) -> Result<PathBuf, PlatformError>;

    /// Nơi lưu device token (không bao giờ ghi token ra file).
    fn credential_store(&self) -> Box<dyn CredentialStore>;

    /// Lấy named mutex `name`. `Ok(None)` khi đã có instance khác giữ mutex.
    fn acquire_single_instance(&self, name: &str) -> Result<Option<InstanceGuard>, PlatformError>;

    /// Đăng ký chạy `exe daemon` khi user đăng nhập (Task Scheduler, không cần admin).
    fn register_autostart(&self, exe: &Path) -> Result<(), PlatformError>;

    /// Gỡ đăng ký chạy nền. Không lỗi nếu chưa từng đăng ký.
    fn unregister_autostart(&self) -> Result<(), PlatformError>;
}

/// Platform của máy đang chạy.
pub fn current() -> Box<dyn Platform> {
    #[cfg(windows)]
    {
        Box::new(windows_impl::WindowsPlatform)
    }
    #[cfg(not(windows))]
    {
        Box::new(UnsupportedPlatform)
    }
}

/// Impl cho hệ điều hành chưa hỗ trợ: mọi thao tác trả [`PlatformError::Unsupported`].
#[derive(Debug, Default, Clone, Copy)]
pub struct UnsupportedPlatform;

impl Platform for UnsupportedPlatform {
    fn data_dir(&self) -> Result<PathBuf, PlatformError> {
        Err(PlatformError::Unsupported {
            feature: "Thư mục dữ liệu",
        })
    }

    fn credential_store(&self) -> Box<dyn CredentialStore> {
        Box::new(credentials::UnsupportedCredentialStore)
    }

    fn acquire_single_instance(&self, _name: &str) -> Result<Option<InstanceGuard>, PlatformError> {
        Err(PlatformError::Unsupported {
            feature: "Named mutex",
        })
    }

    fn register_autostart(&self, _exe: &Path) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported {
            feature: "Chạy nền khi đăng nhập",
        })
    }

    fn unregister_autostart(&self) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported {
            feature: "Chạy nền khi đăng nhập",
        })
    }
}

/// `<thư mục dữ liệu local của user>\teamlens`, dùng chung cho các impl.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn default_data_dir() -> Result<PathBuf, PlatformError> {
    directories::BaseDirs::new()
        .map(|d| d.data_local_dir().join(APP_DIR_NAME))
        .ok_or(PlatformError::NoDataDir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_platform_returns_errors() {
        let p = UnsupportedPlatform;
        assert!(matches!(
            p.data_dir(),
            Err(PlatformError::Unsupported { .. })
        ));
        assert!(p.credential_store().get_token("http://x").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_data_dir_is_under_local_app_data() {
        let dir = current().data_dir().unwrap();
        assert!(dir.ends_with(APP_DIR_NAME));
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            assert!(dir.starts_with(local));
        }
    }

    #[cfg(windows)]
    #[test]
    fn named_mutex_is_exclusive() {
        let p = current();
        let name = format!("teamlens-test-{}", std::process::id());
        let first = p.acquire_single_instance(&name).unwrap();
        assert!(first.is_some());
        let second = p.acquire_single_instance(&name).unwrap();
        assert!(second.is_none(), "instance thứ hai không được lấy mutex");
        drop(first);
        let third = p.acquire_single_instance(&name).unwrap();
        assert!(third.is_some(), "nhả mutex xong thì lấy lại được");
    }
}
