//! `tl daemon` — chế độ nền (task M3.2): tự quét và gửi session, không cần `tl sync`.
//!
//! Chạy foreground được (thử tay, xem log ngay trên console, Ctrl+C để dừng). Task
//! Scheduler (M3.8) gọi `tl daemon --background`: không in gì ra console, log chỉ ghi
//! vào `daemon.log` trong thư mục dữ liệu. Mỗi thư mục dữ liệu chỉ một instance; instance
//! thứ hai báo rồi thoát với mã 0.
//!
//! Tự cập nhật (M5.3): khi daemon đã thay `tl.exe` bằng bản mới (hoặc thấy `tl update` chạy tay
//! đã thay), lệnh này nhả named mutex rồi chạy `tl daemon` bằng file mới
//! ([`crate::update::restart::spawn_daemon`]): chạy nền thì tách tiến trình và thoát ngay,
//! foreground thì chạy bản mới trong cùng console.

use std::io::Write;

use clap::Args;

use crate::context::AppContext;
use crate::daemon::{self, LoopExit};
use crate::error::AppError;
use crate::pipeline::batch::MAX_BATCH_JSON_BYTES;
use crate::sync::Sources;
use crate::update;

#[derive(Debug, Args)]
pub struct DaemonArgs {
    /// Chạy ẩn, chỉ ghi log ra file
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
    // Ghi đường dẫn tl.exe trước khi có thể bị thay (sau khi thay, `current_exe` có thể trỏ
    // sang tên tạm của file cũ).
    let exe = std::env::current_exe().ok();
    let Some(instance) = daemon::instance::acquire(platform.as_ref(), &data_dir)? else {
        if !args.background {
            let _ = writeln!(out, "Daemon đang chạy rồi ({}).", data_dir.display());
        }
        return Ok(());
    };
    let (log_guard, log_path) = daemon::init_log(&data_dir, !args.background)?;
    if !args.background {
        let _ = writeln!(out, "Daemon đang chạy.");
        let _ = writeln!(out, "Log: {}", log_path.display());
        let _ = writeln!(out, "Dừng: Ctrl+C");
        let _ = out.flush();
    }
    let result = daemon::run(ctx, &Sources::from_env(), MAX_BATCH_JSON_BYTES).await;
    let restart = matches!(result, Ok(LoopExit::Restart));
    if restart {
        // Nhả mutex trước rồi mới chạy bản mới: không lúc nào có hai daemon cùng giữ quyền chạy.
        drop(instance);
        let Some(exe) = exe else {
            tracing::warn!("không biết đường dẫn tl.exe, không chạy lại được daemon");
            return Ok(());
        };
        tracing::info!(exe = %exe.display(), "chạy daemon bằng bản tl mới");
        // Nhả file log trước khi bản mới mở lại nó.
        drop(log_guard);
        if !args.background {
            let _ = writeln!(out, "Đã cập nhật tl, đang chạy lại daemon...");
            let _ = out.flush();
        }
        if let Err(e) = update::restart::spawn_daemon(&exe, args.background) {
            // Log đã nhả: báo qua lỗi của lệnh (foreground in ra console).
            return Err(AppError::user(
                format!("Không chạy lại được daemon bằng bản mới: {e}"),
                "Chạy `tl daemon` hoặc đăng nhập lại Windows.",
            ));
        }
        return Ok(());
    }
    drop(log_guard);
    drop(instance);
    if !args.background {
        let _ = writeln!(out, "Đã dừng daemon.");
    }
    result.map(|_| ())
}
