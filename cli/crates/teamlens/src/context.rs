//! Phụ thuộc dùng chung của các lệnh, gom lại để test thay được (config tạm,
//! credential store giả, poll nhanh, không mở trình duyệt).

use std::path::PathBuf;
use std::time::Duration;

use tl_platform::CredentialStore;

use crate::config::{config_path, Config};
use crate::error::AppError;

pub struct AppContext {
    /// Đường dẫn `config.toml`.
    pub config_path: PathBuf,
    /// Nơi lưu device token.
    pub credentials: Box<dyn CredentialStore>,
    /// Độ dài một "giây" khi poll device login. Production = 1 giây; test đặt nhỏ để chạy nhanh.
    pub poll_unit: Duration,
    /// Hàm mở URL trong trình duyệt, trả `false` nếu không mở được.
    pub open_browser: fn(&str) -> bool,
}

impl AppContext {
    /// Context thật của máy đang chạy.
    pub fn from_platform() -> Result<Self, AppError> {
        let platform = tl_platform::current();
        let data_dir = platform.data_dir()?;
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
