//! `tl status` — server, trạng thái đăng nhập, tài khoản và project (qua `GET /agent/v1/whoami`),
//! đồng ý, trạng thái thu thập (`tl pause`), heartbeat gần nhất, agent phát hiện được, file chờ
//! ổn định, hàng đợi, lỗi parse (M3.3). Phần cục bộ chỉ đọc metadata file log và `state.db`.
//! Dòng "Daemon" để M3.2 điền.

use std::io::Write;
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use clap::Args;
use serde::Serialize;

use crate::api_client::{ApiClient, ApiErrorCode, HeartbeatAgent, WhoamiResponse};
use crate::consent::{self, ConsentState};
use crate::context::AppContext;
use crate::error::AppError;
use crate::heartbeat::{self, LastHeartbeat};
use crate::queue::{self, format_bytes, QueueStats};
use crate::state::{state_path, StateDb};
use crate::sync::incremental::{classify, FileStatus};
use crate::sync::Sources;

/// TODO(M3.2): daemon chưa có; khi có thì kiểm tra named mutex để biết daemon đang chạy.
const DAEMON_UNKNOWN: &str = "chưa chạy";

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
    /// Bản đồng ý cục bộ cho server hiện tại, `null` nếu chưa đồng ý.
    pub consent: Option<ConsentState>,
    pub daemon: &'static str,
    /// Đang `tl pause` (không quét, không gửi).
    pub paused: bool,
    /// Lúc bắt đầu tạm dừng (khi `paused`).
    pub paused_since: Option<DateTime<Utc>>,
    /// Heartbeat gần nhất (ghi trong `state.db`).
    pub last_heartbeat: LastHeartbeat,
    /// Agent có file log trên máy.
    pub agents: Vec<HeartbeatAgent>,
    /// Hàng đợi batch chờ gửi (M3.1), `null` khi không đọc được `state.db`.
    pub queue: Option<QueueStats>,
    /// Tổng lỗi parse đang ghi nhận, `None` khi không đọc được `state.db`.
    pub parse_errors: Option<u64>,
    /// Số file log đã đổi nhưng chưa ổn định (sửa chưa tới 2 phút) nên `tl sync` chưa gửi.
    pub waiting_files: Option<usize>,
}

pub async fn run(ctx: &AppContext, args: StatusArgs, out: &mut dyn Write) -> Result<(), AppError> {
    run_with(ctx, args, &Sources::from_env(), out).await
}

/// Như [`run`] nhưng nhận nguồn log (để test).
pub async fn run_with(
    ctx: &AppContext,
    args: StatusArgs,
    sources: &Sources,
    out: &mut dyn Write,
) -> Result<(), AppError> {
    let mut report = collect(ctx).await?;
    fill_local(ctx, sources, &mut report);
    if args.json {
        let text = serde_json::to_string_pretty(&report).expect("StatusReport luôn serialize được");
        let _ = writeln!(out, "{text}");
    } else {
        print_text(out, &report);
    }
    Ok(())
}

/// Phần đọc từ máy: `state.db` (tạm dừng, heartbeat, lỗi parse, hàng đợi) và file log.
fn fill_local(ctx: &AppContext, sources: &Sources, report: &mut StatusReport) {
    report.waiting_files = waiting_files(ctx, sources);
    let path = state_path(&ctx.config_path);
    let exists = path.exists();
    let db = if exists {
        StateDb::open(&path).ok()
    } else {
        None
    };
    report.agents = heartbeat::detect_agents(sources, db.as_ref());
    let Some(db) = db else {
        // Chưa có `state.db`: chưa quét lần nào, hàng đợi trống.
        if !exists {
            report.parse_errors = Some(0);
            report.queue = Some(QueueStats::default());
        }
        return;
    };
    report.paused = db.is_paused().unwrap_or(false);
    if report.paused {
        report.paused_since = db
            .pause_windows()
            .ok()
            .and_then(|w| w.last().filter(|w| w.end.is_none()).map(|w| w.start));
    }
    report.last_heartbeat = heartbeat::last(&db);
    report.queue = queue::queue_stats(&db).ok();
    report.parse_errors = db.parse_error_total().ok();
}

/// Đếm file log đã đổi so với `state.db` nhưng chưa ổn định (chỉ đọc metadata file).
/// `None` khi không mở được `state.db`.
pub fn waiting_files(ctx: &AppContext, sources: &Sources) -> Option<usize> {
    let path = state_path(&ctx.config_path);
    let db = if path.exists() {
        Some(StateDb::open(&path).ok()?)
    } else {
        None
    };
    let now = SystemTime::now();
    let mut n = 0;
    for adapter in sources.adapter_refs() {
        for file in adapter.discover() {
            let prev = match &db {
                Some(db) => db.effective_file(&file.path).ok()?,
                None => None,
            };
            if classify(&file, prev.as_ref(), now, false) == FileStatus::Waiting {
                n += 1;
            }
        }
    }
    Some(n)
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
        consent: consent::current(&config).cloned(),
        daemon: DAEMON_UNKNOWN,
        paused: false,
        paused_since: None,
        last_heartbeat: LastHeartbeat::default(),
        agents: Vec::new(),
        queue: None,
        parse_errors: None,
        waiting_files: None,
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
                    "Token của máy này không còn hiệu lực (đã bị thu hồi?). Chạy lại `tl join <link mời>` để tham gia lại."
                        .to_owned(),
                );
            } else {
                report.account_error = Some(e.to_string());
            }
        }
    }
    Ok(report)
}

fn local_time(t: DateTime<Utc>) -> String {
    t.with_timezone(&chrono::Local)
        .format("%d/%m/%Y %H:%M")
        .to_string()
}

fn print_text(out: &mut dyn Write, r: &StatusReport) {
    let mut w = |label: &str, value: &str| {
        let _ = writeln!(out, "{label:<12}{value}");
    };
    w("Server:", r.server.as_deref().unwrap_or("chưa cấu hình"));

    let login = match (&r.server, r.logged_in, &r.account) {
        (None, _, _) => "chưa — chạy `tl join <link mời>`".to_owned(),
        (Some(_), true, Some(me)) => format!("rồi ({})", me.user.display()),
        (Some(_), true, None) => "rồi (chưa kiểm tra được với server)".to_owned(),
        (Some(_), false, _) => "chưa — chạy `tl join <link mời>`".to_owned(),
    };
    w("Đăng nhập:", &login);
    if let Some(err) = &r.account_error {
        w("Lỗi:", err);
    }

    if let Some(me) = &r.account {
        w(
            "Người dùng:",
            &format!("{} · {}", me.user.display(), me.role),
        );
        w("Thiết bị:", &me.device.name);
        if me.projects.is_empty() {
            w("Project:", "chưa thuộc project nào");
        } else {
            let _ = writeln!(out, "Project:");
            for p in &me.projects {
                let _ = writeln!(out, "  - {} ({})", p.name, p.slug);
                if p.repo_patterns.is_empty() {
                    let _ = writeln!(out, "      (chưa có repo)");
                }
                for pattern in &p.repo_patterns {
                    let _ = writeln!(out, "      {pattern}");
                }
            }
        }
    }

    match &r.consent {
        None => {
            let _ = writeln!(
                out,
                "{:<12}chưa — chạy `tl join <link mời>` (chưa đồng ý thì không gửi gì)",
                "Đồng ý:"
            );
        }
        Some(c) => {
            let _ = writeln!(out, "Đồng ý:");
            for p in &c.projects {
                let _ = writeln!(
                    out,
                    "  - {} ({}): văn bản {}, lúc {}, {}",
                    p.project_name,
                    p.project_slug,
                    p.text_version,
                    local_time(p.accepted_at),
                    if p.backfill {
                        "gửi cả lịch sử cũ"
                    } else {
                        "chỉ gửi session từ lúc đồng ý"
                    }
                );
            }
        }
    }

    let mut w = |label: &str, value: &str| {
        let _ = writeln!(out, "{label:<12}{value}");
    };
    let state = match (r.paused, r.paused_since) {
        (false, _) => "đang thu thập".to_owned(),
        (true, Some(t)) => format!(
            "tạm dừng từ {} — không quét, không gửi; `tl resume` để tiếp tục",
            local_time(t)
        ),
        (true, None) => "tạm dừng — không quét, không gửi; `tl resume` để tiếp tục".to_owned(),
    };
    w("Trạng thái:", &state);
    w("Daemon:", r.daemon);
    let hb = match (r.last_heartbeat.at, &r.last_heartbeat.status) {
        (Some(at), Some(st)) => {
            format!("{} (server ghi nhận: {})", local_time(at), status_label(st))
        }
        (Some(at), None) => local_time(at),
        (None, _) => "chưa gửi".to_owned(),
    };
    w("Heartbeat:", &hb);
    if let Some(err) = &r.last_heartbeat.error {
        w("", &format!("lần gửi gần nhất lỗi: {err}"));
    }
    if r.agents.is_empty() {
        w(
            "Agent:",
            "chưa thấy log của Claude Code hay Codex trên máy này",
        );
    } else {
        let list: Vec<String> = r
            .agents
            .iter()
            .map(|a| match &a.version {
                Some(v) => format!("{} {v} ({} file log)", agent_label(&a.agent), a.files),
                None => format!("{} ({} file log)", agent_label(&a.agent), a.files),
            })
            .collect();
        w("Agent:", &list.join(", "));
    }
    match r.waiting_files {
        Some(0) => w("Chờ gửi:", "không có"),
        Some(n) => w(
            "Chờ gửi:",
            &format!("{n} file log đang được ghi, `tl sync` gửi khi không đổi đủ 2 phút"),
        ),
        None => w("Chờ gửi:", "không đọc được state.db"),
    }
    w("Hàng đợi:", &queue_text(r.queue.as_ref()));
    match r.parse_errors {
        Some(0) => w("Lỗi parse:", "không có"),
        Some(n) => w(
            "Lỗi parse:",
            &format!(
                "{n} (bản ghi log không nhận ra hoặc file đọc lỗi, đã bỏ qua; định dạng log của agent có thể đã đổi)"
            ),
        ),
        None => w("Lỗi parse:", "không đọc được state.db"),
    }
}

fn agent_label(agent: &str) -> &str {
    match agent {
        "claude_code" => "Claude Code",
        "codex" => "Codex",
        other => other,
    }
}

fn status_label(status: &str) -> &str {
    match status {
        "online" => "đang thu thập",
        "paused" => "tạm dừng",
        "consent_revoked" => "đã rút đồng ý",
        other => other,
    }
}

/// Dòng "Hàng đợi" của `tl status`.
fn queue_text(q: Option<&QueueStats>) -> String {
    let Some(q) = q else {
        return "không đọc được state.db".to_owned();
    };
    let mut text = if q.pending_batches == 0 {
        "trống".to_owned()
    } else {
        format!(
            "{} batch chờ gửi ({})",
            q.pending_batches,
            format_bytes(q.pending_bytes)
        )
    };
    if let Some(t) = q.next_attempt_at.filter(|_| q.pending_batches > 0) {
        text.push_str(&format!(", thử lại lúc {}", queue::local_time(t)));
    }
    if q.failed_batches > 0 {
        text.push_str(&format!(
            ", {} batch hỏng (server từ chối)",
            q.failed_batches
        ));
    }
    if q.dropped_batches > 0 {
        text.push_str(&format!(", đã bỏ {} batch do đầy", q.dropped_batches));
    }
    text
}
