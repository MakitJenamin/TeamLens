//! `tl sync` — ép quét và gửi ngay.
//!
//! Chưa làm, thuộc task M1-X6.

use clap::Args;

use crate::error::AppError;

#[derive(Debug, Args)]
pub struct SyncArgs {}

pub fn run(_args: SyncArgs) -> Result<(), AppError> {
    Err(AppError::NotImplemented {
        command: "sync",
        task: "M1-X6",
    })
}
