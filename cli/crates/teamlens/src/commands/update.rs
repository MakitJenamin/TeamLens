//! `tl update` — cập nhật `tl` lên bản phát hành ổn định mới nhất trên GitHub (task M5.3).
//!
//! Chạy tay, không tự chạy ngầm trong lệnh khác: `tl sync` gặp server đòi bản mới chỉ nhắc chạy
//! `tl update`. Daemon tự cập nhật riêng ([`crate::update::auto`]).

use std::io::Write;

use chrono::Utc;
use clap::Args;

use crate::context::AppContext;
use crate::error::AppError;
use crate::state::{state_path, StateDb};
use crate::update::{self, auto, Check, Release, UpdateError, Updater};

const AFTER_HELP: &str = "\
Biến môi trường (thử nghiệm offline với server tĩnh local):
  TL_UPDATE_BASE_URL  Thư mục chứa tl-x86_64-pc-windows-msvc.zip và SHA256SUMS, thay cho
                      GitHub (ví dụ http://127.0.0.1:8000/releases/download/v0.1.1-rc.1).
                      Không gọi GitHub API; phiên bản đích lấy từ TL_UPDATE_VERSION hoặc
                      từ đoạn cuối của URL nếu nó là tag (v<semver>).
  TL_UPDATE_VERSION   Phiên bản đích (ví dụ 0.2.0), bỏ qua GitHub API.
  TL_AUTO_UPDATE      0 để tắt tự cập nhật của daemon.";

#[derive(Debug, Args)]
#[command(after_help = AFTER_HELP)]
pub struct UpdateArgs {
    /// Chỉ kiểm tra có bản mới hay không, không tải, không cài
    #[arg(long)]
    pub check: bool,
}

pub async fn run(ctx: &AppContext, args: UpdateArgs, out: &mut dyn Write) -> Result<(), AppError> {
    let updater = Updater::from_env().map_err(UpdateError::into_app_error)?;
    let check = check_and_record(ctx, &updater).await?;
    if !report_check(&check, args.check, out) {
        return Ok(());
    }
    install(ctx, &updater, &check.latest, out).await
}

/// Kiểm bản mới và ghi kết quả vào `state.db` (cho `tl status`; lỗi ghi bỏ qua).
pub async fn check_and_record(ctx: &AppContext, updater: &Updater) -> Result<Check, AppError> {
    let result = updater.check().await;
    let path = state_path(&ctx.config_path);
    if let Ok(db) = StateDb::open(&path) {
        let now = Utc::now();
        let _ = match &result {
            Ok(c) => auto::record_check(&db, now, &c.latest.version),
            Err(e) => auto::record_failure(&db, now, &e.to_string()),
        };
    }
    result.map_err(UpdateError::into_app_error)
}

/// In kết quả kiểm tra. Trả `true` khi cần tải và cài (có bản mới, không `--check`).
pub fn report_check(check: &Check, only_check: bool, out: &mut dyn Write) -> bool {
    let (current, latest) = (&check.current, &check.latest.version);
    if !check.newer() {
        let _ = if latest == current {
            writeln!(out, "tl {current} đã là bản mới nhất.")
        } else {
            writeln!(
                out,
                "tl {current} đã là bản mới nhất (bản phát hành mới nhất: {latest})."
            )
        };
        return false;
    }
    if only_check {
        let _ = writeln!(
            out,
            "Có bản mới: tl {latest} (đang dùng {current}). Chạy `tl update` để cập nhật."
        );
        return false;
    }
    true
}

async fn install(
    ctx: &AppContext,
    updater: &Updater,
    release: &Release,
    out: &mut dyn Write,
) -> Result<(), AppError> {
    let current = update::current_version();
    let _ = writeln!(
        out,
        "Đang tải tl {} (đang dùng {current})...",
        release.version
    );
    let _ = out.flush();
    let data_dir = ctx
        .config_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let dir = update::work_dir(&data_dir).map_err(UpdateError::into_app_error)?;
    let new_exe = updater
        .download_verified(release, dir.path())
        .await
        .map_err(UpdateError::into_app_error)?;
    let _ = writeln!(out, "Đã kiểm SHA-256 khớp với SHA256SUMS.");
    update::verify_binary(&new_exe, &release.version).map_err(UpdateError::into_app_error)?;
    update::install(&new_exe).map_err(UpdateError::into_app_error)?;
    let _ = writeln!(out, "Đã cập nhật tl {current} → {}.", release.version);
    let daemon_running =
        crate::daemon::instance::is_running(tl_platform::current().as_ref(), &data_dir);
    if daemon_running == Some(true) {
        let _ = writeln!(
            out,
            "Daemon đang chạy sẽ tự chuyển sang bản mới trong vòng 10 phút."
        );
    }
    Ok(())
}
