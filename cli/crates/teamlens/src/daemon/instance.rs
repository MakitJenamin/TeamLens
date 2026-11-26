//! Một instance daemon cho mỗi thư mục dữ liệu: named mutex Windows (`Local\...`, qua
//! [`tl_platform::Platform::acquire_single_instance`]).
//!
//! Tên mutex gắn với thư mục dữ liệu (`TL_DATA_DIR`), nên thử nghiệm với thư mục dữ liệu
//! riêng không đụng daemon thật của máy.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::time::Duration;

use tl_platform::{InstanceGuard, Platform, PlatformError};

/// Số lần thử lấy mutex lúc khởi động (`tl status` có thể đang giữ mutex trong tích tắc để kiểm tra).
const ACQUIRE_ATTEMPTS: u32 = 3;
const ACQUIRE_RETRY_DELAY: Duration = Duration::from_millis(200);

/// Tên mutex của daemon cho `data_dir`.
pub fn mutex_name(data_dir: &Path) -> String {
    let normalized = data_dir
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_lowercase();
    let mut h = DefaultHasher::new();
    normalized.hash(&mut h);
    format!("teamlens-daemon-{:016x}", h.finish())
}

/// Lấy quyền chạy daemon. `Ok(None)` khi instance khác đang chạy.
pub fn acquire(
    platform: &dyn Platform,
    data_dir: &Path,
) -> Result<Option<InstanceGuard>, PlatformError> {
    let name = mutex_name(data_dir);
    for attempt in 1..=ACQUIRE_ATTEMPTS {
        if let Some(guard) = platform.acquire_single_instance(&name)? {
            return Ok(Some(guard));
        }
        if attempt < ACQUIRE_ATTEMPTS {
            std::thread::sleep(ACQUIRE_RETRY_DELAY);
        }
    }
    Ok(None)
}

/// Daemon của `data_dir` có đang chạy không (thử lấy mutex rồi nhả ngay).
/// `None` khi không kiểm tra được (hệ điều hành chưa hỗ trợ...).
pub fn is_running(platform: &dyn Platform, data_dir: &Path) -> Option<bool> {
    match platform.acquire_single_instance(&mutex_name(data_dir)) {
        Ok(Some(guard)) => {
            drop(guard);
            Some(false)
        }
        Ok(None) => Some(true),
        Err(e) => {
            tracing::debug!(error = %e, "không kiểm tra được mutex daemon");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_mutex_on_dinh_theo_thu_muc() {
        let a = mutex_name(Path::new(r"C:\Users\x\AppData\Local\teamlens"));
        let b = mutex_name(Path::new(r"c:\users\X\AppData\Local\teamlens\"));
        let c = mutex_name(Path::new(r"C:\tmp\tl-test"));
        assert_eq!(a, b, "khác hoa thường/dấu \\ cuối vẫn là một thư mục");
        assert_ne!(a, c);
        assert!(a.starts_with("teamlens-daemon-"));
        assert!(!a.contains('\\'), "tên mutex không được chứa \\");
    }

    #[cfg(windows)]
    #[test]
    fn instance_thu_hai_bi_tu_choi() {
        let platform = tl_platform::current();
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(is_running(platform.as_ref(), dir.path()), Some(false));
        let first = acquire(platform.as_ref(), dir.path()).unwrap();
        assert!(first.is_some());
        assert_eq!(is_running(platform.as_ref(), dir.path()), Some(true));
        let second = acquire(platform.as_ref(), dir.path()).unwrap();
        assert!(second.is_none(), "instance thứ hai không được chạy");
        // Thư mục dữ liệu khác: daemon riêng, không bị chặn.
        let other = tempfile::tempdir().unwrap();
        assert!(acquire(platform.as_ref(), other.path()).unwrap().is_some());
        drop(first);
        assert_eq!(is_running(platform.as_ref(), dir.path()), Some(false));
        assert!(acquire(platform.as_ref(), dir.path()).unwrap().is_some());
    }
}
