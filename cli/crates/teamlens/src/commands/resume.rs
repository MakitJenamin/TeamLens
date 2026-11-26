//! `tl resume` — tiếp tục thu thập sau `tl pause` (M3.3): xóa cờ tạm dừng, gửi heartbeat
//! `online` ngay.

use std::io::Write;

use clap::Args;

use crate::commands::pause::set_paused;
use crate::context::AppContext;
use crate::error::AppError;
use crate::sync::Sources;

#[derive(Debug, Args)]
pub struct ResumeArgs {}

pub async fn run(ctx: &AppContext, _args: ResumeArgs, out: &mut dyn Write) -> Result<(), AppError> {
    set_paused(ctx, false, &Sources::from_env(), out).await
}
