//! `tl logout` — báo server thu hồi token của máy này rồi xóa token khỏi Credential Manager.
//!
//! Lỗi mạng khi báo server không chặn việc xóa token trên máy.

use std::io::Write;

use clap::Args;

use crate::api_client::ApiClient;
use crate::context::AppContext;
use crate::error::AppError;

#[derive(Debug, Args)]
pub struct LogoutArgs {}

pub async fn run(ctx: &AppContext, _args: LogoutArgs, out: &mut dyn Write) -> Result<(), AppError> {
    let config = ctx.load_config()?;
    let Some(server_url) = config.server_url else {
        let _ = writeln!(out, "Máy này chưa đăng nhập server TeamLens nào.");
        return Ok(());
    };

    let Some(token) = ctx.credentials.get_token(&server_url)? else {
        let _ = writeln!(out, "Máy này chưa đăng nhập vào {server_url}.");
        return Ok(());
    };

    match ApiClient::new(&server_url, Some(token)) {
        Ok(client) => {
            if let Err(e) = client.logout().await {
                tracing::debug!(error = ?e, "báo logout lên server thất bại");
                let _ = writeln!(
                    out,
                    "Cảnh báo: chưa báo được server ({e}). Vẫn xóa token trên máy; có thể thu hồi thiết bị trên dashboard."
                );
            }
        }
        Err(e) => tracing::debug!(error = ?e, "không tạo được HTTP client"),
    }

    ctx.credentials.delete_token(&server_url)?;
    let _ = writeln!(out, "Đã đăng xuất khỏi {server_url}.");
    Ok(())
}
