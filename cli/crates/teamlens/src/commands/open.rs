//! `tl open` — mở dashboard trên trình duyệt, đăng nhập sẵn bằng device token (SPEC 7.1).
//!
//! Gọi `POST /agent/v1/web-login` lấy link một lần (sống 60 giây) rồi mở bằng trình duyệt.

use std::io::Write;

use clap::Args;

use crate::api_client::{ApiClient, ApiError, ApiErrorCode};
use crate::context::AppContext;
use crate::error::AppError;

#[derive(Debug, Args)]
pub struct OpenArgs {
    /// Chỉ in link, không mở trình duyệt
    #[arg(long)]
    pub no_browser: bool,
}

/// Trả về link đã mở/in (để test kiểm tra).
pub async fn run(
    ctx: &AppContext,
    args: OpenArgs,
    out: &mut dyn Write,
) -> Result<String, AppError> {
    let config = ctx.load_config()?;
    let not_joined = || {
        AppError::user(
            "Máy này chưa tham gia TeamLens.",
            "Chạy `tl join <link mời>` trước.",
        )
    };
    let server_url = config.server_url.ok_or_else(not_joined)?;
    let token = ctx
        .credentials
        .get_token(&server_url)?
        .ok_or_else(not_joined)?;

    let client = ApiClient::new(&server_url, Some(token))?;
    let login = client.web_login().await.map_err(|e| {
        let revoked = matches!(
            e.code(),
            Some(ApiErrorCode::InvalidToken | ApiErrorCode::Unauthenticated)
        ) || matches!(e, ApiError::Api { status: 401, .. });
        if revoked {
            AppError::user(
                "Token của máy này không còn hiệu lực.",
                "Xin leader link mời còn hạn rồi chạy lại `tl join <link mời>`.",
            )
        } else {
            AppError::Api(e)
        }
    })?;

    let print_link = |out: &mut dyn Write| {
        let _ = writeln!(out, "{}", login.url);
        let _ = writeln!(
            out,
            "Link dùng một lần, hết hạn sau {} giây.",
            login.expires_in
        );
        let _ = writeln!(out, "Đừng gửi link này cho người khác.");
    };
    if args.no_browser {
        print_link(out);
    } else if (ctx.open_browser)(&login.url) {
        let _ = writeln!(out, "Đã mở dashboard trên trình duyệt.");
    } else {
        let _ = writeln!(out, "Không mở được trình duyệt. Mở link này:");
        print_link(out);
    }
    let _ = out.flush();
    Ok(login.url)
}
