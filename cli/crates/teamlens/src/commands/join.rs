//! `tl join` — lưu server từ link mời, device login, màn hình đồng ý, đăng ký daemon.
//!
//! Chưa làm, thuộc task B3.

use clap::Args;

use crate::error::AppError;

#[derive(Debug, Args)]
pub struct JoinArgs {
    /// Link mời, ví dụ https://teamlens.congty.com/i/<mã>
    pub invite_url: String,
}

pub fn run(_args: JoinArgs) -> Result<(), AppError> {
    Err(AppError::NotImplemented {
        command: "join",
        task: "B3",
    })
}
