//! File log của daemon (`daemon.log` trong thư mục dữ liệu), xoay vòng theo kích thước:
//! vượt [`MAX_LOG_BYTES`] thì đổi tên thành `daemon.log.1` (đè bản cũ) và ghi file mới.
//! Tổng dung lượng log tối đa ~2 × [`MAX_LOG_BYTES`].
//!
//! Log chỉ có số đếm, đường dẫn file log và thông báo lỗi; không có nội dung prompt hay token.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Tên file log trong thư mục dữ liệu.
pub const LOG_FILE_NAME: &str = "daemon.log";
/// Kích thước tối đa một file log.
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// File log tự xoay vòng.
#[derive(Debug)]
pub struct RotatingLog {
    path: PathBuf,
    max_bytes: u64,
    file: Option<File>,
    size: u64,
}

impl RotatingLog {
    pub fn open(path: &Path, max_bytes: u64) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            path: path.to_path_buf(),
            max_bytes,
            file: Some(file),
            size,
        })
    }

    /// Đường dẫn bản cũ (`daemon.log.1`).
    pub fn rotated_path(path: &Path) -> PathBuf {
        let mut s = path.as_os_str().to_owned();
        s.push(".1");
        PathBuf::from(s)
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file = None; // Đóng trước khi đổi tên (Windows không cho đổi tên file đang mở).
        let old = Self::rotated_path(&self.path);
        let _ = std::fs::remove_file(&old);
        std::fs::rename(&self.path, &old)?;
        self.file = Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?,
        );
        self.size = 0;
        Ok(())
    }
}

impl Write for RotatingLog {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.size > 0
            && self.size + buf.len() as u64 > self.max_bytes
            && self.rotate().is_err()
            && self.file.is_none()
        {
            // Không xoay được (file bị khóa...): ghi tiếp vào file hiện tại.
            self.file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)?,
            );
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("file log chưa mở"))?;
        let n = file.write(buf)?;
        self.size += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.file.as_mut() {
            Some(f) => f.flush(),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xoay_vong_khi_vuot_gioi_han() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join(LOG_FILE_NAME);
        let mut log = RotatingLog::open(&path, 100).unwrap();
        for i in 0..30 {
            writeln!(log, "dòng {i:02}").unwrap();
        }
        log.flush().unwrap();
        let current = std::fs::metadata(&path).unwrap().len();
        let old = RotatingLog::rotated_path(&path);
        assert!(old.exists(), "phải có daemon.log.1");
        assert!(current <= 100, "file hiện tại {current} byte");
        assert!(std::fs::metadata(&old).unwrap().len() <= 100);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("dòng 29"));

        // Mở lại: tiếp tục từ kích thước hiện có.
        drop(log);
        let log = RotatingLog::open(&path, 100).unwrap();
        assert_eq!(log.size, current);
    }
}
