//! `tl consent` — xem và đồng ý lại; `tl consent revoke` — rút đồng ý (task M3.7, SPEC 4.1, 4.3).
//!
//! - `tl consent`: gọi `GET /agent/v1/consent`, hiện văn bản hiện hành và trạng thái đồng ý (trên
//!   server và trên máy). Đã đồng ý bản hiện hành thì không làm gì; văn bản đổi phiên bản hoặc đã
//!   rút đồng ý thì hỏi `yes` rồi ghi bằng `POST /agent/v1/consent` (`grant`) và cập nhật bản đồng ý
//!   trên máy. Backfill: sau khi đã rút (hoặc chưa từng đồng ý) thì hỏi lại; chỉ khi văn bản đổi
//!   phiên bản thì giữ lựa chọn cũ. `409 consent_outdated` → đọc lại văn bản mới và hỏi lại.
//! - `tl consent revoke`: đánh dấu đã rút trên máy (daemon và `tl sync` dừng gửi ngay), xóa hàng đợi
//!   chưa gửi, rồi báo server (`revoke`). Máy vẫn đăng nhập nên đồng ý lại được bằng `tl consent`;
//!   muốn thu hồi cả thiết bị thì `tl logout` hoặc `tl uninstall`. Dữ liệu đã gửi vẫn nằm trên server
//!   theo retention (leader xóa khi có yêu cầu). Chưa báo được server (mất mạng) vẫn rút ở máy.

use std::io::{BufRead, Write};

use chrono::Utc;
use clap::{Args, Subcommand};
use tl_adapters::Adapter;

use super::join::{ask_backfill, ask_confirmation, format_time, say};
use crate::api_client::{
    ApiClient, ApiErrorCode, ConsentStatus, ConsentUpdate, DeviceConsentState,
};
use crate::config::Config;
use crate::consent::{self, ConsentState};
use crate::context::AppContext;
use crate::error::AppError;
use crate::queue;
use crate::state::{state_path, StateDb};
use crate::sync::Sources;

/// Số lần tối đa đọc lại văn bản khi server báo `consent_outdated`.
const MAX_ATTEMPTS: u32 = 3;

#[derive(Debug, Args)]
pub struct ConsentArgs {
    #[command(subcommand)]
    pub command: Option<ConsentCommand>,

    /// Đồng ý hoặc rút luôn, không hỏi `yes`
    #[arg(long, global = true)]
    pub yes: bool,

    /// Khi đồng ý lại, gửi cả session cũ trên máy
    #[arg(long, conflicts_with = "no_backfill")]
    pub backfill: bool,

    /// Khi đồng ý lại, chỉ gửi session từ bây giờ
    #[arg(long)]
    pub no_backfill: bool,
}

#[derive(Debug, Subcommand)]
pub enum ConsentCommand {
    /// Rút đồng ý, dừng gửi và xóa hàng đợi trên máy
    Revoke,
}

/// Kết quả `tl consent`, trả ra để test kiểm tra.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConsentOutcome {
    /// Đã đồng ý bản hiện hành, không làm gì.
    UpToDate,
    /// Vừa đồng ý bản `text_version`.
    Granted {
        text_version: String,
        backfill: bool,
    },
}

/// Kết quả `tl consent revoke`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevokeOutcome {
    /// Server đã ghi nhận việc rút đồng ý.
    pub server_notified: bool,
    /// Số batch chờ gửi đã xóa khỏi hàng đợi.
    pub cleared_batches: u64,
}

pub async fn run(ctx: &AppContext, args: ConsentArgs, out: &mut dyn Write) -> Result<(), AppError> {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    match args.command {
        None => {
            let sources = Sources::from_env();
            run_with(ctx, &args, &sources.adapter_refs(), &mut input, out)
                .await
                .map(|_| ())
        }
        Some(ConsentCommand::Revoke) => revoke_with(ctx, &args, &mut input, out).await.map(|_| ()),
    }
}

/// Máy chưa tham gia server nào.
fn not_joined() -> AppError {
    AppError::user(
        "Máy này chưa tham gia TeamLens.",
        "Chạy `tl join <link mời>` với link leader gửi.",
    )
}

/// Config, địa chỉ server và client đã có token. Lỗi nếu máy chưa tham gia hoặc chưa có token.
fn connect(ctx: &AppContext) -> Result<(Config, String, ApiClient), AppError> {
    let config = ctx.load_config()?;
    let Some(server_url) = config.server_url.clone() else {
        return Err(not_joined());
    };
    let Some(token) = ctx.credentials.get_token(&server_url)? else {
        return Err(AppError::user(
            format!("Máy này chưa đăng nhập vào {server_url}."),
            "Chạy `tl join <link mời>` để tham gia lại.",
        ));
    };
    let client = ApiClient::new(&server_url, Some(token))?;
    Ok((config, server_url, client))
}

/// `tl consent`: xem trạng thái, đồng ý lại khi cần.
pub async fn run_with(
    ctx: &AppContext,
    args: &ConsentArgs,
    adapters: &[&dyn Adapter],
    input: &mut dyn BufRead,
    out: &mut dyn Write,
) -> Result<ConsentOutcome, AppError> {
    let (mut config, server_url, client) = connect(ctx)?;
    let mut attempt = 0;
    loop {
        attempt += 1;
        let status = client.get_consent().await?;
        show_status(out, &server_url, &status, consent::stored(&config));

        let (has_local, local_ok) = match consent::stored(&config) {
            Some(state) => (
                true,
                !state.is_revoked()
                    && state
                        .projects
                        .iter()
                        .any(|p| p.text_version == status.text_version),
            ),
            None => (false, false),
        };
        if status.status == DeviceConsentState::Granted && local_ok {
            say(out, "\nĐã đồng ý bản hiện hành, không cần làm gì thêm.");
            return Ok(ConsentOutcome::UpToDate);
        }
        if status.status == DeviceConsentState::Granted && !has_local {
            return Err(AppError::user(
                "Server ghi nhận đã đồng ý nhưng máy chưa lưu project nào.",
                "Chạy `tl join <link mời>` để tham gia lại.",
            ));
        }

        let backfill = choose_backfill(args, &status, adapters, input, out)?;
        if !args.yes && !ask_confirmation(input, out, "Gõ `yes` để đồng ý: ")? {
            return Err(AppError::User {
                message: "Đã hủy đồng ý lại. TeamLens vẫn không gửi gì.".into(),
                hint: None,
            });
        }

        let update = ConsentUpdate::Grant {
            text_version: status.text_version.clone(),
            backfill,
        };
        match client.update_consent(&update).await {
            Ok(_) => {
                let updated =
                    consent::regrant(&mut config, &status.text_version, backfill, Utc::now());
                ctx.save_config(&config)?;
                print_granted(out, &status.text_version, backfill, updated);
                return Ok(ConsentOutcome::Granted {
                    text_version: status.text_version,
                    backfill,
                });
            }
            Err(e) if e.code() == Some(&ApiErrorCode::ConsentOutdated) => {
                if attempt >= MAX_ATTEMPTS {
                    return Err(AppError::user(
                        "Văn bản đồng ý trên server liên tục thay đổi.",
                        "Đợi vài phút rồi chạy lại `tl consent`.",
                    ));
                }
                say(out, "\nVăn bản đồng ý vừa thay đổi.");
            }
            Err(e) => return Err(AppError::Api(e)),
        }
    }
}

/// Lựa chọn backfill: cờ dòng lệnh thắng; văn bản đổi phiên bản (đang `outdated`) thì giữ lựa chọn
/// cũ; còn lại (đã rút hoặc chưa từng đồng ý) thì hỏi lại.
fn choose_backfill(
    args: &ConsentArgs,
    status: &ConsentStatus,
    adapters: &[&dyn Adapter],
    input: &mut dyn BufRead,
    out: &mut dyn Write,
) -> Result<bool, AppError> {
    if args.backfill {
        return Ok(true);
    }
    if args.no_backfill {
        return Ok(false);
    }
    if status.status == DeviceConsentState::Outdated {
        let keep = status.backfill.unwrap_or(false);
        say(
            out,
            &format!(
                "Giữ lựa chọn trước đây, {}.",
                if keep {
                    "gửi cả session cũ"
                } else {
                    "chỉ gửi session từ bây giờ"
                }
            ),
        );
        return Ok(keep);
    }
    ask_backfill(input, out, adapters, false)
}

fn status_label(state: DeviceConsentState) -> &'static str {
    match state {
        DeviceConsentState::Granted => "đã đồng ý bản hiện hành",
        DeviceConsentState::Outdated => "cần đồng ý lại, văn bản đã đổi",
        DeviceConsentState::Revoked => "đã rút đồng ý",
        DeviceConsentState::None => "chưa đồng ý",
    }
}

fn show_status(
    out: &mut dyn Write,
    server_url: &str,
    status: &ConsentStatus,
    local: Option<&ConsentState>,
) {
    let _ = writeln!(out);
    let _ = writeln!(out, "══ Đồng ý thu thập dữ liệu ══");
    let mut w = |label: &str, value: &str| {
        let _ = writeln!(out, "{label:<16}{value}");
    };
    w("Server:", server_url);
    w("Trên server:", status_label(status.status));
    w("Bản hiện hành:", &status.text_version);
    if let Some(local) = local {
        let mut versions: Vec<&str> = local
            .projects
            .iter()
            .map(|p| p.text_version.as_str())
            .collect();
        versions.sort_unstable();
        versions.dedup();
        let slugs: Vec<&str> = local
            .projects
            .iter()
            .map(|p| p.project_slug.as_str())
            .collect();
        let backfill = local.projects.iter().any(|p| p.backfill);
        let accepted = local.projects.iter().map(|p| p.accepted_at).max();
        w(
            "Trên máy:",
            &format!(
                "đồng ý bản {}{}",
                versions.join(", "),
                accepted
                    .map(|t| format!(" lúc {}", format_time(&t.to_rfc3339())))
                    .unwrap_or_default()
            ),
        );
        w("Gửi session cũ:", if backfill { "có" } else { "không" });
        w("Project:", &slugs.join(", "));
        if let Some(at) = local.revoked_at {
            w(
                "Đã rút đồng ý:",
                &format!("lúc {}, không gửi gì", format_time(&at.to_rfc3339())),
            );
        }
    }
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "── Văn bản đồng ý (phiên bản {}) ──",
        status.text_version
    );
    for line in status.text.lines() {
        let _ = writeln!(out, "{}", line.trim_end());
    }
    let _ = writeln!(out, "──");
    let _ = out.flush();
}

fn print_granted(out: &mut dyn Write, version: &str, backfill: bool, updated: usize) {
    let _ = writeln!(out);
    let _ = writeln!(out, "Đã đồng ý bản {version}.");
    let _ = writeln!(
        out,
        "{}",
        if backfill {
            "Sẽ gửi cả session cũ thuộc các repo của project."
        } else {
            "Chỉ gửi session từ bây giờ."
        }
    );
    if updated == 0 {
        let _ = writeln!(out, "Máy chưa lưu project nào nên chưa gửi được gì.");
        let _ = writeln!(out, "Tham gia project: `tl join <link mời>`.");
    } else {
        let _ = writeln!(out, "Gửi ngay: `tl sync`.");
    }
    let _ = out.flush();
}

/// Số batch chờ gửi trong `state.db` (không tạo file nếu chưa có).
fn pending_batches(ctx: &AppContext) -> Option<u64> {
    let path = state_path(&ctx.config_path);
    if !path.exists() {
        return None;
    }
    let db = StateDb::open(&path).ok()?;
    queue::queue_stats(&db).ok().map(|s| s.pending_batches)
}

/// Xóa hàng đợi chưa gửi; trả số batch đã xóa.
fn clear_queue(ctx: &AppContext) -> Result<u64, AppError> {
    let path = state_path(&ctx.config_path);
    if !path.exists() {
        return Ok(0);
    }
    let mut db = StateDb::open(&path)?;
    let pending = queue::queue_stats(&db).map_or(0, |s| s.pending_batches);
    queue::clear(&mut db).map_err(|e| {
        tracing::debug!(error = %e, "không xóa được hàng đợi");
        AppError::user(
            "Không xóa được hàng đợi trên máy.",
            "Đóng daemon (`tl daemon`) rồi chạy lại `tl consent revoke`.",
        )
    })?;
    Ok(pending)
}

/// `tl consent revoke`.
pub async fn revoke_with(
    ctx: &AppContext,
    args: &ConsentArgs,
    input: &mut dyn BufRead,
    out: &mut dyn Write,
) -> Result<RevokeOutcome, AppError> {
    let mut config = ctx.load_config()?;
    let Some(server_url) = config.server_url.clone() else {
        say(out, "Máy này chưa tham gia TeamLens, không có gì để rút.");
        return Ok(RevokeOutcome {
            server_notified: false,
            cleared_batches: 0,
        });
    };

    let pending = pending_batches(ctx).unwrap_or(0);
    say(out, "\nRút đồng ý trên máy này sẽ:");
    say(out, "  - dừng gửi ngay, kể cả daemon và `tl sync`;");
    say(
        out,
        &format!("  - xóa hàng đợi chưa gửi trên máy ({pending} batch);"),
    );
    say(out, "  - báo server ghi nhận bạn đã rút đồng ý.");
    say(
        out,
        "Dữ liệu đã gửi vẫn nằm trên server. Muốn xóa, nhờ leader.",
    );
    if !args.yes && !ask_confirmation(input, out, "Gõ `yes` để rút đồng ý: ")? {
        return Err(AppError::User {
            message: "Đã hủy rút đồng ý, không có gì thay đổi.".into(),
            hint: None,
        });
    }

    // 1. Ở máy trước: dừng gửi ngay dù server có báo được hay không.
    if consent::revoke_local(&mut config, Utc::now()) {
        ctx.save_config(&config)?;
    }
    // 2. Xóa hàng đợi chưa gửi.
    let cleared = match clear_queue(ctx) {
        Ok(n) => n,
        Err(e) => {
            say(out, &format!("Cảnh báo: {e}"));
            0
        }
    };
    // 3. Báo server (cố gắng hết sức).
    let mut server_notified = false;
    match ctx.credentials.get_token(&server_url)? {
        Some(token) => {
            let client = ApiClient::new(&server_url, Some(token))?;
            match client.update_consent(&ConsentUpdate::Revoke).await {
                Ok(_) => server_notified = true,
                Err(e) => {
                    tracing::debug!(error = ?e, "báo rút đồng ý thất bại");
                    say(out, &format!("Cảnh báo: chưa báo được server ({e})."));
                    say(
                        out,
                        "Máy đã ngừng gửi. Chạy lại `tl consent revoke` khi có mạng.",
                    );
                }
            }
        }
        None => say(
            out,
            "Cảnh báo: chưa có token nên chưa báo được server. Máy đã ngừng gửi.",
        ),
    }

    let _ = writeln!(out);
    say(out, "Đã rút đồng ý. TeamLens không gửi gì nữa.");
    if cleared > 0 {
        say(out, &format!("Đã xóa {cleared} batch chưa gửi."));
    }
    if server_notified {
        say(out, "Server đã ghi nhận.");
    }
    say(out, "Đồng ý lại: `tl consent`.");
    say(out, "Gỡ TeamLens: `tl uninstall`.");
    Ok(RevokeOutcome {
        server_notified,
        cleared_batches: cleared,
    })
}
