//! `tl uninstall` — gỡ task khởi động, xóa config và hàng đợi, báo server.
//!
//! Chưa làm, thuộc task M3.7.

use clap::Args;

use crate::error::AppError;

#[derive(Debug, Args)]
pub struct UninstallArgs {}

pub fn run(_args: UninstallArgs) -> Result<(), AppError> {
    Err(AppError::NotImplemented {
        command: "uninstall",
        task: "M3.7",
    })
}
