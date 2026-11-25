//! `tl sync` — ép quét và gửi ngay.
//!
//! Chưa làm, thuộc task A7.

use clap::Args;

use crate::error::AppError;

#[derive(Debug, Args)]
pub struct SyncArgs {}

pub fn run(_args: SyncArgs) -> Result<(), AppError> {
    Err(AppError::NotImplemented {
        command: "sync",
        task: "A7",
    })
}
