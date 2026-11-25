//! `tl login` — device login (giống `gh auth login`).
//!
//! 1. `POST /agent/v1/device/code` lấy `userCode`.
//! 2. In mã thật to, mở trình duyệt tới `verificationUriComplete`.
//! 3. Poll `POST /agent/v1/device/token` theo `interval` (`slow_down` → +5 giây).
//! 4. Lưu `server_url` vào config, token vào Credential Manager.

use std::io::Write;
use std::time::Duration;

use clap::Args;

use crate::api_client::{ApiClient, ApiError, ApiErrorCode, DeviceCodeRequest, DeviceCodeResponse};
use crate::config::normalize_server_url;
use crate::context::AppContext;
use crate::error::AppError;

/// Số giây cộng thêm vào `interval` mỗi lần server trả `slow_down`.
pub const SLOW_DOWN_STEP_SECS: u64 = 5;
/// Số lần lỗi tạm thời liên tiếp tối đa (mất mạng, proxy 5xx) khi poll trước khi bỏ cuộc.
const MAX_CONSECUTIVE_TRANSIENT_ERRORS: u32 = 3;

#[derive(Debug, Args)]
pub struct LoginArgs {
    /// Địa chỉ server TeamLens, ví dụ https://teamlens.congty.com (mặc định: server trong config)
    #[arg(long, value_name = "URL")]
    pub server: Option<String>,

    /// Không tự mở trình duyệt, chỉ in link
    #[arg(long)]
    pub no_browser: bool,
}

/// Kết quả đăng nhập, trả ra để test kiểm tra.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginOutcome {
    pub server_url: String,
    pub device_id: String,
    /// Email lấy từ `whoami`; `None` nếu gọi `whoami` thất bại.
    pub email: Option<String>,
    /// Số lần đã gọi `/device/token`.
    pub polls: u32,
    /// `interval` (giây) tại thời điểm thành công, sau các lần `slow_down`.
    pub final_interval_secs: u64,
}

pub async fn run(
    ctx: &AppContext,
    args: LoginArgs,
    out: &mut dyn Write,
) -> Result<LoginOutcome, AppError> {
    let mut config = ctx.load_config()?;
    let server_url = match args.server.as_deref() {
        Some(s) => normalize_server_url(s)?,
        None => config.server_url.clone().ok_or_else(|| {
            AppError::user(
                "Chưa biết địa chỉ server TeamLens.",
                "Chạy `tl login --server https://teamlens.congty.com` (địa chỉ do leader gửi), hoặc `tl join <link mời>`.",
            )
        })?,
    };

    let client = ApiClient::new(&server_url, None)?;
    let code = client
        .device_code(&DeviceCodeRequest {
            device_name: super::device_name(),
            os: super::OS_NAME.to_owned(),
            cli_version: crate::CLI_VERSION.to_owned(),
        })
        .await?;

    print_user_code(out, &code);
    if args.no_browser {
        say(
            out,
            "Mở link trên bằng trình duyệt, đăng nhập rồi xác nhận mã.",
        );
    } else if (ctx.open_browser)(&code.verification_uri_complete) {
        say(out, "Đã mở trình duyệt. Đăng nhập rồi xác nhận mã ở trên.");
    } else {
        say(
            out,
            "Không mở được trình duyệt, hãy tự mở link trên rồi xác nhận mã.",
        );
    }
    say(out, "Đang chờ xác nhận... (Ctrl+C để hủy)");

    let polled = poll_for_token(ctx, &client, &code).await?;

    revoke_previous_token(ctx, &server_url, &polled.access_token).await;
    ctx.credentials
        .set_token(&server_url, &polled.access_token)?;
    config.server_url = Some(server_url.clone());
    ctx.save_config(&config)?;

    let authed = ApiClient::new(&server_url, Some(polled.access_token))?;
    let email = match authed.whoami().await {
        Ok(me) => {
            say(
                out,
                &format!("Đã đăng nhập: {} trên {}", me.user.email, server_url),
            );
            Some(me.user.email)
        }
        Err(e) => {
            tracing::debug!(error = ?e, "whoami sau khi đăng nhập thất bại");
            say(
                out,
                &format!("Đã đăng nhập trên {server_url} (chưa lấy được thông tin tài khoản: {e})"),
            );
            None
        }
    };

    Ok(LoginOutcome {
        server_url,
        device_id: polled.device_id,
        email,
        polls: polled.polls,
        final_interval_secs: polled.interval_secs,
    })
}

/// Máy đã có token cho server này (đăng nhập lại): báo server thu hồi token cũ để nó
/// không còn hiệu lực. Best effort: mọi lỗi đều bỏ qua, không chặn đăng nhập.
async fn revoke_previous_token(ctx: &AppContext, server_url: &str, new_token: &str) {
    let old = match ctx.credentials.get_token(server_url) {
        Ok(Some(old)) if old != new_token => old,
        Ok(_) => return,
        Err(e) => {
            tracing::debug!(error = ?e, "không đọc được token cũ để thu hồi");
            return;
        }
    };
    match ApiClient::new(server_url, Some(old)) {
        Ok(client) => {
            if let Err(e) = client.logout().await {
                tracing::debug!(error = ?e, "thu hồi token cũ thất bại, bỏ qua");
            }
        }
        Err(e) => tracing::debug!(error = ?e, "không tạo được HTTP client để thu hồi token cũ"),
    }
}

/// Lỗi tạm thời khi poll: mất mạng, hoặc proxy trả 5xx (502/503/504) không đúng định dạng API.
fn is_transient(e: &ApiError) -> bool {
    match e {
        ApiError::Network { .. } => true,
        ApiError::InvalidResponse { status, .. } => *status >= 500,
        _ => false,
    }
}

struct Polled {
    access_token: String,
    device_id: String,
    polls: u32,
    interval_secs: u64,
}

async fn poll_for_token(
    ctx: &AppContext,
    client: &ApiClient,
    code: &DeviceCodeResponse,
) -> Result<Polled, AppError> {
    let mut interval = code.interval.max(1);
    let mut waited: u64 = 0;
    let mut polls: u32 = 0;
    let mut transient_errors: u32 = 0;

    loop {
        if waited >= code.expires_in {
            return Err(expired());
        }
        sleep_units(ctx.poll_unit, interval).await;
        waited += interval;
        polls += 1;

        match client.device_token(&code.device_code).await {
            Ok(token) => {
                return Ok(Polled {
                    access_token: token.access_token,
                    device_id: token.device_id,
                    polls,
                    interval_secs: interval,
                })
            }
            Err(ApiError::Api { code: c, .. }) => {
                transient_errors = 0;
                match c {
                    ApiErrorCode::AuthorizationPending => {}
                    ApiErrorCode::SlowDown => interval += SLOW_DOWN_STEP_SECS,
                    ApiErrorCode::ExpiredToken => return Err(expired()),
                    ApiErrorCode::AccessDenied => {
                        return Err(AppError::user(
                            "Yêu cầu đăng nhập đã bị từ chối.",
                            "Chạy lại `tl login` nếu đó là nhầm lẫn.",
                        ))
                    }
                    other => {
                        return Err(AppError::user(
                            format!(
                                "Server trả lỗi không mong đợi khi chờ xác nhận: {}",
                                other.as_str()
                            ),
                            "Thử lại `tl login`; nếu vẫn lỗi, báo admin kiểm tra server.",
                        ))
                    }
                }
            }
            Err(e) if is_transient(&e) => {
                transient_errors += 1;
                tracing::debug!(error = ?e, transient_errors, "lỗi tạm thời khi poll token");
                if transient_errors >= MAX_CONSECUTIVE_TRANSIENT_ERRORS {
                    return Err(e.into());
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
}

fn expired() -> AppError {
    AppError::user(
        "Mã xác nhận đã hết hạn.",
        "Chạy lại `tl login` và xác nhận mã trong vòng 15 phút.",
    )
}

async fn sleep_units(unit: Duration, n: u64) {
    let n = u32::try_from(n).unwrap_or(u32::MAX);
    tokio::time::sleep(unit.saturating_mul(n)).await;
}

fn print_user_code(out: &mut dyn Write, code: &DeviceCodeResponse) {
    // Giãn cách từng ký tự cho dễ đọc: "W D J B - M J H T".
    let spaced: String = code
        .user_code
        .chars()
        .map(|c| c.to_string())
        .collect::<Vec<_>>()
        .join(" ");
    let width = spaced.chars().count() + 8;
    let bar = "═".repeat(width);
    let _ = writeln!(out);
    let _ = writeln!(out, "  Mã xác nhận của máy này:");
    let _ = writeln!(out);
    let _ = writeln!(out, "    ╔{bar}╗");
    let _ = writeln!(out, "    ║{}║", " ".repeat(width));
    let _ = writeln!(out, "    ║    {spaced}    ║");
    let _ = writeln!(out, "    ║{}║", " ".repeat(width));
    let _ = writeln!(out, "    ╚{bar}╝");
    let _ = writeln!(out);
    let _ = writeln!(out, "  Mở: {}", code.verification_uri_complete);
    let _ = writeln!(
        out,
        "  (hoặc vào {} và nhập mã ở trên)",
        code.verification_uri
    );
    let _ = writeln!(out);
}

fn say(out: &mut dyn Write, line: &str) {
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}
