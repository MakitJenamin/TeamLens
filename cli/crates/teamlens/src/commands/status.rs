//! `tl status` — server, trạng thái đăng nhập, tài khoản và project (qua `GET /agent/v1/whoami`).
//!
//! Phần daemon, agent phát hiện được, hàng đợi thuộc task M3.2, M3.3.

use std::io::Write;

use clap::Args;
use serde::Serialize;

use crate::api_client::{ApiClient, ApiErrorCode, WhoamiResponse};
use crate::context::AppContext;
use crate::error::AppError;

const PENDING_DAEMON: &str = "chưa có (task M3.3)";

#[derive(Debug, Args)]
pub struct StatusArgs {
    /// In kết quả dạng JSON
    #[arg(long)]
    pub json: bool,
}

/// Báo cáo trạng thái; cũng là định dạng của `tl status --json`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub cli_version: &'static str,
    /// Server trong config, `null` nếu chưa cấu hình.
    pub server: Option<String>,
    /// Có token của server này trong Credential Manager và token còn hiệu lực
    /// (nếu kiểm tra được).
    pub logged_in: bool,
    /// Thông tin từ `whoami`, `null` nếu chưa đăng nhập hoặc gọi thất bại.
    pub account: Option<WhoamiResponse>,
    /// Lý do không lấy được `account` khi đã có token.
    pub account_error: Option<String>,
    pub daemon: &'static str,
    pub agents: &'static str,
    pub queue: &'static str,
}

pub async fn run(ctx: &AppContext, args: StatusArgs, out: &mut dyn Write) -> Result<(), AppError> {
    let report = collect(ctx).await?;
    if args.json {
        let text = serde_json::to_string_pretty(&report).expect("StatusReport luôn serialize được");
        let _ = writeln!(out, "{text}");
    } else {
        print_text(out, &report);
    }
    Ok(())
}

/// Thu thập trạng thái. Lỗi mạng/token không làm lệnh thất bại, chỉ ghi vào `account_error`.
pub async fn collect(ctx: &AppContext) -> Result<StatusReport, AppError> {
    let config = ctx.load_config()?;
    let mut report = StatusReport {
        cli_version: crate::CLI_VERSION,
        server: config.server_url.clone(),
        logged_in: false,
        account: None,
        account_error: None,
        daemon: PENDING_DAEMON,
        agents: PENDING_DAEMON,
        queue: PENDING_DAEMON,
    };

    let Some(server_url) = config.server_url else {
        return Ok(report);
    };
    let Some(token) = ctx.credentials.get_token(&server_url)? else {
        return Ok(report);
    };
    report.logged_in = true;

    let client = ApiClient::new(&server_url, Some(token))?;
    match client.whoami().await {
        Ok(me) => report.account = Some(me),
        Err(e) => {
            if matches!(
                e.code(),
                Some(ApiErrorCode::InvalidToken | ApiErrorCode::Unauthenticated)
            ) {
                report.logged_in = false;
                report.account_error = Some(
                    "Token của máy này không còn hiệu lực (đã bị thu hồi?). Chạy `tl login` để đăng nhập lại."
                        .to_owned(),
                );
            } else {
                report.account_error = Some(e.to_string());
            }
        }
    }
    Ok(report)
}

fn print_text(out: &mut dyn Write, r: &StatusReport) {
    let mut w = |label: &str, value: &str| {
        let _ = writeln!(out, "{label:<12}{value}");
    };
    w("Server:", r.server.as_deref().unwrap_or("chưa cấu hình"));

    let login = match (&r.server, r.logged_in, &r.account) {
        (None, _, _) => "chưa — chạy `tl login --server <địa chỉ>`".to_owned(),
        (Some(_), true, Some(me)) => format!("rồi ({})", me.user.email),
        (Some(_), true, None) => "rồi (chưa kiểm tra được với server)".to_owned(),
        (Some(_), false, _) => "chưa — chạy `tl login`".to_owned(),
    };
    w("Đăng nhập:", &login);
    if let Some(err) = &r.account_error {
        w("Lỗi:", err);
    }

    if let Some(me) = &r.account {
        w(
            "Người dùng:",
            &format!("{} <{}>", me.user.name, me.user.email),
        );
        w("Thiết bị:", &me.device.name);
        if me.projects.is_empty() {
            w("Project:", "chưa thuộc project nào");
        } else {
            let _ = writeln!(out, "Project:");
            for p in &me.projects {
                let _ = writeln!(out, "  - {} ({}) · {}", p.name, p.slug, p.role);
                if p.repo_patterns.is_empty() {
                    let _ = writeln!(out, "      (chưa có repo)");
                }
                for pattern in &p.repo_patterns {
                    let _ = writeln!(out, "      {pattern}");
                }
            }
        }
    }

    let mut w = |label: &str, value: &str| {
        let _ = writeln!(out, "{label:<12}{value}");
    };
    w("Daemon:", r.daemon);
    w("Agent:", r.agents);
    w("Hàng đợi:", r.queue);
}
