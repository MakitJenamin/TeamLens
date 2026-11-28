//! `tl mcp` — cầu nối MCP stdio cho Claude Code, Codex (M6.4).
//!
//! Cài vào agent: `claude mcp add teamlens -- tl mcp`. Dùng device token có sẵn từ `tl join`
//! (Credential Manager), nên không cần cấu hình thêm. Logic cầu nối ở [`crate::mcp`].

use std::io::Write;

use clap::Args;

use crate::api_client::ApiClient;
use crate::context::AppContext;
use crate::error::AppError;

#[derive(Debug, Args)]
pub struct McpArgs {}

pub async fn run(ctx: &AppContext, _args: McpArgs, out: &mut dyn Write) -> Result<(), AppError> {
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
    let stdin = tokio::io::BufReader::new(tokio::io::stdin());
    run_with(&client, stdin, out).await
}

/// Chạy cầu nối với client và nguồn đọc cho trước (test dùng bộ đệm thay stdin).
pub async fn run_with<R: tokio::io::AsyncBufRead + Unpin>(
    client: &ApiClient,
    input: R,
    out: &mut dyn Write,
) -> Result<(), AppError> {
    crate::mcp::serve(client, input, out).await.map_err(|e| {
        AppError::user(
            format!("Lỗi đọc hoặc ghi stdio của MCP: {e}"),
            "Thử chạy lại agent; nếu vẫn lỗi, chạy `tl status` để kiểm tra.",
        )
    })
}
