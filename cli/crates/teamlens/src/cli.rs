//! Định nghĩa tham số dòng lệnh (clap derive).

use clap::{Parser, Subcommand};

use crate::commands::{
    consent, daemon, join, logout, open, pause, preview, resume, status, sync, uninstall,
};

/// TeamLens: thu thập session AI agent trong repo của team, che secret, gửi về server tự host.
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
    /// Tham gia project từ link mời: xem và đồng ý, nhận token cho máy này
    #[command(visible_alias = "login")]
    Join(join::JoinArgs),
    /// Mở dashboard trên trình duyệt, đã đăng nhập sẵn
    Open(open::OpenArgs),
    /// Đăng xuất: thu hồi token của máy này
    Logout(logout::LogoutArgs),
    /// Trạng thái đăng nhập, project, daemon, hàng đợi
    Status(status::StatusArgs),
    /// Xem chính xác dữ liệu sẽ gửi (sau khi che secret và cắt output)
    Preview(preview::PreviewArgs),
    /// Quét và gửi ngay
    Sync(sync::SyncArgs),
    /// Tạm dừng thu thập
    Pause(pause::PauseArgs),
    /// Tiếp tục thu thập
    Resume(resume::ResumeArgs),
    /// Quản lý đồng ý thu thập dữ liệu
    Consent(consent::ConsentArgs),
    /// Chế độ nền (do Task Scheduler gọi)
    #[command(hide = true)]
    Daemon(daemon::DaemonArgs),
    /// Gỡ TeamLens khỏi máy này
    Uninstall(uninstall::UninstallArgs),
}
