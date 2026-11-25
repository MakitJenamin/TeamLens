//! `tl consent` — quản lý đồng ý thu thập dữ liệu.
//!
//! Chưa làm, thuộc task M3-X3.

use clap::{Args, Subcommand};

use crate::error::AppError;

#[derive(Debug, Args)]
pub struct ConsentArgs {
    #[command(subcommand)]
    pub command: ConsentCommand,
}

#[derive(Debug, Subcommand)]
pub enum ConsentCommand {
    /// Rút đồng ý: dừng daemon, xóa hàng đợi local, báo server
    Revoke,
}

pub fn run(args: ConsentArgs) -> Result<(), AppError> {
    match args.command {
        ConsentCommand::Revoke => Err(AppError::NotImplemented {
            command: "consent revoke",
            task: "M3-X3",
        }),
    }
}
