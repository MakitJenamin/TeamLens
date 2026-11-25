//! `tl resume` — tiếp tục thu thập sau `tl pause`.
//!
//! Chưa làm, thuộc task M3-Y3.

use clap::Args;

use crate::error::AppError;

#[derive(Debug, Args)]
pub struct ResumeArgs {}

pub fn run(_args: ResumeArgs) -> Result<(), AppError> {
    Err(AppError::NotImplemented {
        command: "resume",
        task: "M3-Y3",
    })
}
