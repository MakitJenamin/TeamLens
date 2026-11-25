//! `tl daemon` — chế độ nền, do Task Scheduler gọi (ẩn khỏi help).
//!
//! Chưa làm, thuộc task A11.

use clap::Args;

use crate::error::AppError;

#[derive(Debug, Args)]
pub struct DaemonArgs {}

pub fn run(_args: DaemonArgs) -> Result<(), AppError> {
    Err(AppError::NotImplemented {
        command: "daemon",
        task: "A11",
    })
}
