//! Impl Windows của [`Platform`].

use std::path::{Path, PathBuf};

use windows::core::HSTRING;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;

use crate::{
    autostart_command, default_data_dir, scheduler, CredentialStore, InstanceGuard,
    KeyringCredentialStore, Platform, PlatformError, AUTOSTART_TASK_NAME,
};

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct WindowsPlatform;

/// Handle của named mutex; đóng khi drop.
struct MutexHandle(HANDLE);

// SAFETY: handle mutex chỉ được đóng đúng một lần khi drop; dùng được từ thread bất kỳ.
unsafe impl Send for MutexHandle {}

impl Drop for MutexHandle {
    fn drop(&mut self) {
        // SAFETY: handle hợp lệ, do CreateMutexW trả về và chưa bị đóng.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

impl Platform for WindowsPlatform {
    fn data_dir(&self) -> Result<PathBuf, PlatformError> {
        default_data_dir()
    }

    fn credential_store(&self) -> Box<dyn CredentialStore> {
        Box::new(KeyringCredentialStore)
    }

    fn acquire_single_instance(&self, name: &str) -> Result<Option<InstanceGuard>, PlatformError> {
        // `Local\` = phạm vi phiên đăng nhập hiện tại, không cần quyền admin.
        let full_name = HSTRING::from(format!("Local\\{name}"));
        // SAFETY: gọi Win32 với tên hợp lệ; handle được bọc trong MutexHandle để tự đóng.
        unsafe {
            let handle = CreateMutexW(None, true, &full_name)
                .map_err(|e| PlatformError::Os(e.to_string()))?;
            let already_exists = GetLastError() == ERROR_ALREADY_EXISTS;
            let guard = MutexHandle(handle);
            if already_exists {
                return Ok(None);
            }
            Ok(Some(InstanceGuard::new(Box::new(guard))))
        }
    }

    fn register_autostart(&self, exe: &Path) -> Result<(), PlatformError> {
        let (command, arguments) = autostart_command(exe)?;
        scheduler::register_task(AUTOSTART_TASK_NAME, &command, &arguments)
    }

    fn unregister_autostart(&self) -> Result<(), PlatformError> {
        scheduler::unregister_task(AUTOSTART_TASK_NAME)
    }

    fn autostart_registered(&self) -> Result<bool, PlatformError> {
        scheduler::task_exists(AUTOSTART_TASK_NAME)
    }

    fn start_autostart(&self) -> Result<(), PlatformError> {
        scheduler::run_task(AUTOSTART_TASK_NAME)
    }
}
