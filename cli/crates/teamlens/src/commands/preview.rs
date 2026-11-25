//! `tl preview` — hiển thị chính xác payload sẽ gửi (sau khi che secret và cắt output).
//!
//! Chưa làm, thuộc task M1-X6.

use clap::Args;

use crate::error::AppError;

#[derive(Debug, Args)]
pub struct PreviewArgs {
    /// Session cần xem (id hoặc đường dẫn file log); bỏ trống để chọn session gần nhất
    pub session: Option<String>,
}

pub fn run(_args: PreviewArgs) -> Result<(), AppError> {
    Err(AppError::NotImplemented {
        command: "preview",
        task: "M1-X6",
    })
}
