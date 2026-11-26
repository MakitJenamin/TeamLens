//! `tl pause` — tạm dừng thu thập; server ghi nhận trạng thái `paused` (M3.3).
//!
//! Ghi cờ `meta.paused` và mở một khoảng tạm dừng trong `state.db`, rồi gửi heartbeat
//! `paused` ngay. Khi tạm dừng, `tl sync` (và daemon M3.2) không quét, không gửi gì. Sau
//! `tl resume`, turn có thời điểm nằm trong khoảng tạm dừng **không bao giờ** được gửi
//! (`PlannedSession::drop_paused_turns`). Mất mạng thì vẫn tạm dừng ở máy; server biết ở
//! heartbeat thành công kế tiếp.

use std::io::Write;

use clap::Args;

use crate::api_client::DeviceRunStatus;
use crate::context::AppContext;
use crate::error::AppError;
use crate::heartbeat;
use crate::state::{state_path, StateDb};
use crate::sync::Sources;

#[derive(Debug, Args)]
pub struct PauseArgs {}

pub async fn run(ctx: &AppContext, _args: PauseArgs, out: &mut dyn Write) -> Result<(), AppError> {
    set_paused(ctx, true, &Sources::from_env(), out).await
}

/// Dùng chung cho `tl pause` và `tl resume`; nhận nguồn log để test.
pub async fn set_paused(
    ctx: &AppContext,
    paused: bool,
    sources: &Sources,
    out: &mut dyn Write,
) -> Result<(), AppError> {
    let db = StateDb::open(&state_path(&ctx.config_path))?;
    let was_paused = db.is_paused().unwrap_or(false);
    db.set_paused(paused, chrono::Utc::now()).map_err(|e| {
        tracing::debug!(error = %e, "không ghi được cờ tạm dừng");
        AppError::user(
            "Không ghi được trạng thái tạm dừng vào state.db.",
            "Kiểm tra quyền ghi thư mục dữ liệu TeamLens rồi chạy lại.",
        )
    })?;
    drop(db);

    let _ = match (paused, was_paused) {
        (true, true) => writeln!(out, "TeamLens đã tạm dừng từ trước: không quét, không gửi gì."),
        (true, false) => writeln!(
            out,
            "Đã tạm dừng thu thập: TeamLens không quét, không gửi gì cho tới khi chạy `tl resume`. Những gì bạn làm với agent trong lúc tạm dừng sẽ không bao giờ được gửi."
        ),
        (false, false) => writeln!(out, "TeamLens đang chạy bình thường (không tạm dừng)."),
        (false, true) => writeln!(
            out,
            "Đã tiếp tục thu thập. Phần session phát sinh trong lúc tạm dừng được bỏ qua, không bao giờ gửi."
        ),
    };

    let wanted = if paused {
        DeviceRunStatus::Paused
    } else {
        DeviceRunStatus::Online
    };
    let Some(client) = heartbeat::client_for(ctx)? else {
        let _ = writeln!(
            out,
            "Máy này chưa tham gia server nào nên chỉ đổi trạng thái ở máy."
        );
        return Ok(());
    };
    match heartbeat::send_once(ctx, &client, sources).await {
        Ok(res) if res.status == "consent_revoked" => {
            let _ = writeln!(
                out,
                "Server: thiết bị này đã rút đồng ý chia sẻ dữ liệu nên vẫn không gửi gì."
            );
        }
        Ok(res) => {
            let _ = writeln!(out, "Đã báo server: trạng thái thiết bị là {}.", res.status);
            if res.status != wanted.as_str() {
                tracing::debug!(server = %res.status, "server ghi nhận trạng thái khác");
            }
        }
        Err(e) => {
            tracing::debug!(error = %e, "heartbeat thất bại");
            let _ = writeln!(
                out,
                "Chưa báo được server ({e}). Trạng thái ở máy đã đổi; server sẽ biết ở lần heartbeat tới."
            );
        }
    }
    Ok(())
}
