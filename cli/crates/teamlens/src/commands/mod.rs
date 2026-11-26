//! Mỗi lệnh `tl` một file. Lệnh chưa làm trả [`AppError::NotImplemented`] (mã thoát 2).

pub mod consent;
pub mod daemon;
pub mod join;
pub mod login;
pub mod logout;
pub mod pause;
pub mod preview;
pub mod resume;
pub mod status;
pub mod sync;
pub mod uninstall;

use std::io::Write;

use crate::cli::Command;
use crate::context::AppContext;
use crate::error::AppError;

/// Chạy một lệnh. `make_ctx` chỉ được gọi khi lệnh cần context (lệnh khung không cần).
pub async fn dispatch(
    command: Command,
    make_ctx: impl FnOnce() -> Result<AppContext, AppError>,
    out: &mut dyn Write,
) -> Result<(), AppError> {
    match command {
        Command::Join(args) => join::run(args),
        Command::Pause(args) => pause::run(args),
        Command::Resume(args) => resume::run(args),
        Command::Consent(args) => consent::run(args),
        Command::Daemon(args) => daemon::run(args),
        Command::Uninstall(args) => uninstall::run(args),
        Command::Login(args) => login::run(&make_ctx()?, args, out).await.map(|_| ()),
        Command::Logout(args) => logout::run(&make_ctx()?, args, out).await,
        Command::Status(args) => status::run(&make_ctx()?, args, out).await,
        Command::Preview(args) => preview::run(&make_ctx()?, args, out).await,
        Command::Sync(args) => sync::run(&make_ctx()?, args, out).await,
    }
}

/// Tên máy, gửi lên server làm `deviceName`.
pub(crate) fn device_name() -> String {
    ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .map(|v| v.trim().to_owned())
        .find(|v| !v.is_empty())
        .unwrap_or_else(|| "may-khong-ten".to_owned())
}

/// Tên hệ điều hành gửi lên server (`os`): `windows`, `macos`, `linux`.
pub(crate) const OS_NAME: &str = std::env::consts::OS;
