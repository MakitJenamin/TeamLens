//! `tl uninstall` — gỡ TeamLens khỏi máy: báo server, gỡ task khởi động, xóa token, config và
//! hàng đợi (task M3.7, SPEC 4.1).
//!
//! Thứ tự: (1) báo server rút đồng ý rồi thu hồi thiết bị (cố gắng hết sức, mất mạng thì chỉ cảnh
//! báo); (2) gỡ task Task Scheduler và dừng daemon do task chạy (M3.8) để nhả file đang giữ;
//! (3) xóa token trong Credential Manager; (4) xóa các file TeamLens trong thư mục dữ liệu
//! (`config.toml`, `state.db`, log, cache cấu hình; **chỉ đúng các file này**, không xóa cả thư mục
//! vì `TL_DATA_DIR` có thể trỏ tới nơi khác). Không tự xóa `tl.exe` (không xóa được file đang
//! chạy): chỉ nhắc người dùng. Dữ liệu đã gửi vẫn nằm trên server theo retention.

use std::io::{BufRead, Write};
use std::path::PathBuf;

use clap::Args;
use tl_platform::Platform;

use super::join::{ask_confirmation, say};
use crate::api_client::{ApiClient, ConsentUpdate};
use crate::config::Config;
use crate::context::AppContext;
use crate::daemon::log::{RotatingLog, LOG_FILE_NAME};
use crate::error::AppError;
use crate::state::state_path;
use crate::sync::agent_config::CACHE_FILE_NAME;

#[derive(Debug, Args)]
pub struct UninstallArgs {
    /// Gỡ luôn, không hỏi gõ `yes` (cho tự động hóa)
    #[arg(long)]
    pub yes: bool,
}

/// Kết quả gỡ cài đặt, trả ra để test kiểm tra.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UninstallReport {
    /// Server đã ghi nhận việc rút đồng ý.
    pub server_notified: bool,
    /// Server đã thu hồi thiết bị này.
    pub device_revoked: bool,
    /// Đã gỡ task khởi động.
    pub task_removed: bool,
    /// Đã xóa token khỏi Credential Manager.
    pub token_deleted: bool,
    /// Tên các file đã xóa.
    pub removed_files: Vec<String>,
    /// Tên các file không xóa được (thường vì daemon chạy tay đang giữ).
    pub failed_files: Vec<String>,
}

pub async fn run(
    ctx: &AppContext,
    args: UninstallArgs,
    out: &mut dyn Write,
) -> Result<(), AppError> {
    let platform = tl_platform::current();
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let report = run_with(ctx, &args, platform.as_ref(), &mut input, out).await?;
    if let Ok(exe) = std::env::current_exe() {
        let _ = writeln!(
            out,
            "Có thể xóa file chương trình {} (và bỏ khỏi PATH nếu bạn đã thêm).",
            exe.display()
        );
    }
    drop(report);
    Ok(())
}

/// Các file TeamLens trong thư mục dữ liệu (theo vị trí `config.toml`).
fn data_files(ctx: &AppContext) -> Vec<PathBuf> {
    let state = state_path(&ctx.config_path);
    let with_suffix = |suffix: &str| {
        let mut name = state.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    };
    let dir = ctx
        .config_path
        .parent()
        .map(PathBuf::from)
        .unwrap_or_default();
    let log = dir.join(LOG_FILE_NAME);
    vec![
        ctx.config_path.clone(),
        state.clone(),
        with_suffix("-wal"),
        with_suffix("-shm"),
        RotatingLog::rotated_path(&log),
        log,
        dir.join(CACHE_FILE_NAME),
    ]
}

/// `tl uninstall` với `platform` (để test thay Task Scheduler thật).
pub async fn run_with(
    ctx: &AppContext,
    args: &UninstallArgs,
    platform: &dyn Platform,
    input: &mut dyn BufRead,
    out: &mut dyn Write,
) -> Result<UninstallReport, AppError> {
    let config = ctx.load_config()?;

    say(out, "\nGỡ TeamLens khỏi máy này sẽ:");
    say(
        out,
        "  - báo server rút đồng ý và thu hồi thiết bị này (cần mạng; không có mạng thì chỉ cảnh báo);",
    );
    say(
        out,
        "  - gỡ tác vụ tự chạy khi đăng nhập Windows và dừng daemon;",
    );
    say(
        out,
        "  - xóa token đăng nhập, cấu hình, hàng đợi chưa gửi và log trên máy.",
    );
    say(
        out,
        "Dữ liệu đã gửi trước đó vẫn nằm trên server; muốn xóa hẳn, nhờ leader xóa dữ liệu của bạn.",
    );
    if !args.yes
        && !ask_confirmation(
            input,
            out,
            "Gõ `yes` để gỡ TeamLens (gõ gì khác hoặc Enter là hủy): ",
        )?
    {
        say(out, "Đã hủy, không có gì thay đổi.");
        return Err(AppError::user(
            "Đã hủy gỡ cài đặt.",
            "Khi muốn gỡ, chạy lại `tl uninstall` và gõ `yes`.",
        ));
    }

    let mut report = UninstallReport::default();

    // 1. Báo server (cố gắng hết sức). Rút đồng ý trước, vì thu hồi thiết bị làm token hết hiệu lực.
    if let Some(server_url) = &config.server_url {
        match ctx.credentials.get_token(server_url)? {
            Some(token) => notify_server(server_url, token, &mut report, out).await?,
            None => say(
                out,
                "Cảnh báo: máy chưa có token đăng nhập nên chưa báo được server.",
            ),
        }
    }

    // 2. Gỡ task khởi động (dừng luôn daemon do task chạy).
    match platform.unregister_autostart() {
        Ok(()) => report.task_removed = true,
        Err(e) => say(
            out,
            &format!("Cảnh báo: chưa gỡ được tác vụ tự chạy ({e})."),
        ),
    }

    // 3. Token.
    if let Some(server_url) = &config.server_url {
        match ctx.credentials.delete_token(server_url) {
            Ok(()) => report.token_deleted = true,
            Err(e) => say(
                out,
                &format!("Cảnh báo: chưa xóa được token trong Credential Manager ({e})."),
            ),
        }
    }

    // 4. File trong thư mục dữ liệu.
    for path in data_files(ctx) {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        match std::fs::remove_file(&path) {
            Ok(()) => report.removed_files.push(name),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::debug!(error = %e, path = %path.display(), "không xóa được file");
                report.failed_files.push(name);
            }
        }
    }
    if let Some(dir) = ctx.config_path.parent() {
        // Chỉ xóa được khi thư mục đã rỗng; còn file khác của người dùng thì giữ nguyên.
        let _ = std::fs::remove_dir(dir);
    }

    print_summary(out, &report, &config);
    Ok(report)
}

/// Báo server rút đồng ý rồi thu hồi thiết bị; lỗi chỉ cảnh báo.
async fn notify_server(
    server_url: &str,
    token: String,
    report: &mut UninstallReport,
    out: &mut dyn Write,
) -> Result<(), AppError> {
    let client = ApiClient::new(server_url, Some(token))?;
    match client.update_consent(&ConsentUpdate::Revoke).await {
        Ok(_) => report.server_notified = true,
        Err(e) => {
            tracing::debug!(error = ?e, "báo rút đồng ý thất bại");
            say(
                out,
                &format!("Cảnh báo: chưa báo được server rút đồng ý ({e})."),
            );
        }
    }
    match client.logout().await {
        Ok(()) => report.device_revoked = true,
        Err(e) => {
            tracing::debug!(error = ?e, "thu hồi thiết bị thất bại");
            say(
                out,
                &format!(
                    "Cảnh báo: chưa thu hồi được thiết bị trên server ({e}); leader có thể thu hồi trên dashboard."
                ),
            );
        }
    }
    Ok(())
}

fn print_summary(out: &mut dyn Write, report: &UninstallReport, config: &Config) {
    let _ = writeln!(out);
    say(out, "Đã gỡ TeamLens khỏi máy này:");
    let yes_no = |b: bool| {
        if b {
            "đã làm"
        } else {
            "chưa làm được"
        }
    };
    if config.server_url.is_some() {
        say(
            out,
            &format!(
                "  - báo server rút đồng ý: {}",
                yes_no(report.server_notified)
            ),
        );
        say(
            out,
            &format!(
                "  - thu hồi thiết bị trên server: {}",
                yes_no(report.device_revoked)
            ),
        );
        say(
            out,
            &format!("  - xóa token đăng nhập: {}", yes_no(report.token_deleted)),
        );
    }
    say(
        out,
        &format!(
            "  - gỡ tác vụ tự chạy khi đăng nhập: {}",
            yes_no(report.task_removed)
        ),
    );
    if report.removed_files.is_empty() {
        say(out, "  - không có file nào trên máy cần xóa.");
    } else {
        say(
            out,
            &format!("  - đã xóa file: {}", report.removed_files.join(", ")),
        );
    }
    if !report.failed_files.is_empty() {
        say(
            out,
            &format!(
                "Chưa xóa được: {}. Có thể daemon chạy tay (`tl daemon`) đang giữ file: đóng nó rồi chạy lại `tl uninstall`, hoặc tự xóa file.",
                report.failed_files.join(", ")
            ),
        );
    }
}
