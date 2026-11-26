//! `tl daemon` — chế độ nền (task M3.2): tự quét và gửi session, không cần `tl sync`.
//!
//! Chạy foreground được (thử tay, xem log ngay trên console, Ctrl+C để dừng). Task
//! Scheduler (M3.8) gọi `tl daemon --background`: không in gì ra console, log chỉ ghi
//! vào `daemon.log` trong thư mục dữ liệu. Mỗi thư mục dữ liệu chỉ một instance; instance
//! thứ hai báo rồi thoát với mã 0.

use std::io::Write;

use clap::Args;

use crate::context::AppContext;
use crate::daemon;
use crate::error::AppError;
use crate::pipeline::batch::MAX_BATCH_JSON_BYTES;
use crate::sync::Sources;

#[derive(Debug, Args)]
pub struct DaemonArgs {
    /// Chạy ẩn (Task Scheduler): không in ra console, log chỉ ghi vào file
    #[arg(long)]
    pub background: bool,
}

pub async fn run(ctx: &AppContext, args: DaemonArgs, out: &mut dyn Write) -> Result<(), AppError> {
    let data_dir = ctx
        .config_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    std::fs::create_dir_all(&data_dir).map_err(|e| AppError::Config {
        path: data_dir.display().to_string(),
        detail: e.to_string(),
    })?;
    let platform = tl_platform::current();
    let Some(_instance) = daemon::instance::acquire(platform.as_ref(), &data_dir)? else {
        if !args.background {
            let _ = writeln!(
                out,
                "Daemon TeamLens đang chạy rồi (cùng thư mục dữ liệu {}), không mở thêm.",
                data_dir.display()
            );
        }
        return Ok(());
    };
    let (_log_guard, log_path) = daemon::init_log(&data_dir, !args.background)?;
    if !args.background {
        let _ = writeln!(
            out,
            "Daemon TeamLens đang chạy, tự gửi session khi file log ổn định 2 phút. Log: {}. Nhấn Ctrl+C để dừng.",
            log_path.display()
        );
        let _ = out.flush();
    }
    let result = daemon::run(ctx, &Sources::from_env(), MAX_BATCH_JSON_BYTES).await;
    if !args.background {
        let _ = writeln!(out, "Đã dừng daemon.");
    }
    result
}
