//! Phụ thuộc dùng chung của các lệnh, gom lại để test thay được (config tạm,
//! credential store giả, poll nhanh, không mở trình duyệt).

use std::path::PathBuf;
use std::time::Duration;

use tl_platform::CredentialStore;

use crate::config::{config_path, Config};
use crate::error::AppError;

/// Biến môi trường đổi thư mục dữ liệu (config, state).
pub const DATA_DIR_ENV: &str = "TL_DATA_DIR";

pub struct AppContext {
    /// Đường dẫn `config.toml`.
    pub config_path: PathBuf,
    /// Nơi lưu device token.
    pub credentials: Box<dyn CredentialStore>,
    /// Độ dài một "giây" khi chờ (`Retry-After` của ingest). Production = 1 giây; test đặt nhỏ để chạy nhanh.
    pub poll_unit: Duration,
    /// Hàm mở URL trong trình duyệt, trả `false` nếu không mở được.
    pub open_browser: fn(&str) -> bool,
}

impl AppContext {
    /// Context thật của máy đang chạy. Biến môi trường `TL_DATA_DIR` (nếu có) thay thư mục
    /// dữ liệu mặc định `%LOCALAPPDATA%\teamlens`, dùng khi thử nhiều server trên một máy;
    /// token vẫn nằm trong Credential Manager (khóa theo địa chỉ server).
    pub fn from_platform() -> Result<Self, AppError> {
        let platform = tl_platform::current();
        let data_dir = match std::env::var_os(DATA_DIR_ENV).filter(|v| !v.is_empty()) {
            Some(dir) => PathBuf::from(dir),
            None => platform.data_dir()?,
        };
        Ok(Self {
            config_path: config_path(&data_dir),
            credentials: platform.credential_store(),
            poll_unit: Duration::from_secs(1),
            open_browser: |url| webbrowser::open(url).is_ok(),
        })
    }

    pub fn load_config(&self) -> Result<Config, AppError> {
        Config::load(&self.config_path)
    }

    pub fn save_config(&self, config: &Config) -> Result<(), AppError> {
        config.save(&self.config_path)
    }
}
