//! File cấu hình `%LOCALAPPDATA%\teamlens\config.toml`.
//!
//! Chỉ chứa thiết lập không nhạy cảm. Token KHÔNG BAO GIỜ ghi vào đây
//! (token nằm trong Credential Manager, xem `tl_platform::CredentialStore`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// Tên file cấu hình trong thư mục dữ liệu.
pub const CONFIG_FILE_NAME: &str = "config.toml";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    /// Địa chỉ server TeamLens, đã chuẩn hóa (không có `/` ở cuối).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    /// Trạng thái đồng ý cục bộ (ghi bởi `tl join`, đọc bởi `crate::consent`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consent: Option<crate::consent::ConsentState>,
}

impl Config {
    /// Đọc config; chưa có file thì trả config rỗng.
    pub fn load(path: &Path) -> Result<Self, AppError> {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(config_error(path, e)),
        };
        toml::from_str(&text).map_err(|e| config_error(path, e))
    }

    /// Ghi config, tự tạo thư mục cha nếu chưa có.
    pub fn save(&self, path: &Path) -> Result<(), AppError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| config_error(path, e))?;
        }
        let text = toml::to_string(self).map_err(|e| config_error(path, e))?;
        std::fs::write(path, text).map_err(|e| config_error(path, e))
    }
}

/// Đường dẫn config trong thư mục dữ liệu.
pub fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CONFIG_FILE_NAME)
}

fn config_error(path: &Path, e: impl std::fmt::Display) -> AppError {
    AppError::Config {
        path: path.display().to_string(),
        detail: e.to_string(),
    }
}

/// Chuẩn hóa địa chỉ server người dùng nhập: bỏ khoảng trắng và `/` ở cuối,
/// bắt buộc `http://` hoặc `https://`.
pub fn normalize_server_url(input: &str) -> Result<String, AppError> {
    let trimmed = input.trim().trim_end_matches('/');
    let lower = trimmed.to_ascii_lowercase();
    let has_scheme = lower.starts_with("http://") || lower.starts_with("https://");
    let host = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or("");
    if !has_scheme || host.is_empty() || host.contains(char::is_whitespace) {
        return Err(AppError::user(
            format!("Địa chỉ server không hợp lệ: \"{}\"", input.trim()),
            "Địa chỉ phải có http:// hoặc https://, ví dụ link mời https://teamlens.congty.com/i/<mã>.",
        ));
    }
    Ok(trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_server_url() {
        assert_eq!(
            normalize_server_url(" http://localhost:3000/ ").unwrap(),
            "http://localhost:3000"
        );
        assert_eq!(
            normalize_server_url("https://tl.example.com").unwrap(),
            "https://tl.example.com"
        );
        assert!(normalize_server_url("localhost:3000").is_err());
        assert!(normalize_server_url("http://").is_err());
    }

    #[test]
    fn config_roundtrip_and_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_path(&dir.path().join("teamlens"));
        assert_eq!(Config::load(&path).unwrap(), Config::default());

        let cfg = Config {
            server_url: Some("http://localhost:3000".into()),
            ..Default::default()
        };
        cfg.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("server_url = \"http://localhost:3000\""));
        assert_eq!(Config::load(&path).unwrap(), cfg);
    }
}
