//! Định nghĩa tham số dòng lệnh (clap derive).

use clap::{Parser, Subcommand};

use crate::commands::{
    consent, daemon, join, logout, open, pause, preview, resume, status, sync, uninstall, update,
};

/// TeamLens: gửi session AI agent trong repo của team về server, đã che secret.
#[derive(Debug, Parser)]
#[command(
    name = "tl",
    bin_name = "tl",
    version,
    about,
    propagate_version = true,
    disable_help_subcommand = true
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Tham gia project bằng link mời
    #[command(visible_alias = "login")]
    Join(join::JoinArgs),
    /// Mở dashboard, đăng nhập sẵn
    Open(open::OpenArgs),
    /// Đăng xuất và thu hồi token của máy này
    Logout(logout::LogoutArgs),
    /// Xem đăng nhập, project, daemon, hàng đợi
    Status(status::StatusArgs),
    /// Xem đúng dữ liệu sẽ gửi, đã che secret
    Preview(preview::PreviewArgs),
    /// Quét và gửi ngay
    Sync(sync::SyncArgs),
    /// Tạm dừng thu thập
    Pause(pause::PauseArgs),
    /// Tiếp tục thu thập
    Resume(resume::ResumeArgs),
    /// Xem, đồng ý lại hoặc rút đồng ý
    Consent(consent::ConsentArgs),
    /// Chế độ nền (do Task Scheduler gọi)
    #[command(hide = true)]
    Daemon(daemon::DaemonArgs),
    /// Gỡ TeamLens khỏi máy này
    Uninstall(uninstall::UninstallArgs),
    /// Cập nhật tl lên bản mới nhất
    Update(update::UpdateArgs),
}
