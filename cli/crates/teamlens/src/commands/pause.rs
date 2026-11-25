//! `tl pause` — tạm dừng thu thập; server ghi nhận trạng thái `paused`.
//!
//! Chưa làm, thuộc task M3-Y3.

use clap::Args;

use crate::error::AppError;

#[derive(Debug, Args)]
pub struct PauseArgs {}

pub fn run(_args: PauseArgs) -> Result<(), AppError> {
    Err(AppError::NotImplemented {
        command: "pause",
        task: "M3-Y3",
    })
}
