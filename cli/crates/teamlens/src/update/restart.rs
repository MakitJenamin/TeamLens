//! Chạy bản `tl` mới sau khi thay file: daemon nhả named mutex rồi gọi [`spawn_daemon`].
//!
//! - Chạy nền (`--background`, Task Scheduler): tiến trình mới tách khỏi console và nhóm tiến
//!   trình, kế thừa biến môi trường (`TL_DATA_DIR`...), tiến trình cũ thoát ngay. Tiến trình mới
//!   lấy mutex (thử lại vài lần); nếu instance khác đã giành trước thì nó tự thoát, nên không có
//!   hai daemon cùng chạy.
//! - Chạy foreground (thử tay): chạy bản mới trong cùng console và chờ nó kết thúc.
//!
//! [`ExeStamp`]: daemon nhận ra file thực thi đã bị thay bởi `tl update` chạy tay để tự
//! khởi động lại sang bản mới.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

/// Dấu vết file thực thi (kích thước + mtime) để biết file đã bị thay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExeStamp {
    pub path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

impl ExeStamp {
    pub fn of(path: &Path) -> Option<Self> {
        let m = std::fs::metadata(path).ok()?;
        Some(Self {
            path: path.to_path_buf(),
            len: m.len(),
            modified: m.modified().ok(),
        })
    }

    /// File thực thi đang chạy lúc khởi động.
    pub fn current() -> Option<Self> {
        Self::of(&std::env::current_exe().ok()?)
    }

    /// File ở đường dẫn đã khác lúc ghi dấu (bị thay bằng bản khác)?
    /// Không đọc được metadata (đang thay dở) thì coi như chưa đổi.
    pub fn changed(&self) -> bool {
        match Self::of(&self.path) {
            Some(now) => now != *self,
            None => false,
        }
    }
}

/// Khởi động `tl daemon` từ `exe`. Chạy nền: trả ngay sau khi spawn (`Ok(None)`);
/// foreground: chờ tiến trình mới kết thúc, trả mã thoát của nó.
pub fn spawn_daemon(exe: &Path, background: bool) -> std::io::Result<Option<i32>> {
    let mut cmd = Command::new(exe);
    cmd.arg("daemon");
    if background {
        cmd.arg("--background")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        return spawn_detached(cmd).map(|_| None);
    }
    cmd.status().map(|s| Some(s.code().unwrap_or(1)))
}

#[cfg(windows)]
fn spawn_detached(mut cmd: Command) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    // Task Scheduler chạy task trong một job; thoát khỏi job để task cũ kết thúc không kéo
    // theo daemon mới. Job không cho breakaway thì spawn bình thường.
    cmd.creation_flags(base | CREATE_BREAKAWAY_FROM_JOB);
    match cmd.spawn() {
        Ok(_) => Ok(()),
        Err(e) => {
            tracing::debug!(error = %e, "spawn có CREATE_BREAKAWAY_FROM_JOB lỗi, thử lại không có");
            cmd.creation_flags(base);
            cmd.spawn().map(|_| ())
        }
    }
}

#[cfg(not(windows))]
fn spawn_detached(mut cmd: Command) -> std::io::Result<()> {
    cmd.spawn().map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nhan_ra_file_bi_thay() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("tl.exe");
        std::fs::write(&exe, b"ban cu").unwrap();
        let stamp = ExeStamp::of(&exe).unwrap();
        assert!(!stamp.changed());
        std::fs::write(&exe, b"ban moi dai hon").unwrap();
        assert!(stamp.changed());
        std::fs::remove_file(&exe).unwrap();
        let gone = ExeStamp::of(&dir.path().join("khong-co.exe"));
        assert!(gone.is_none());
    }
}
