//! `tl sync` — quét log, lọc phạm vi, che secret, cắt rồi gửi ngay lên server.
//!
//! Mốc 1 (M1.7): chạy đúng một lần rồi thoát, cả khi không có `--once`. Chế độ chạy
//! lặp/nền là daemon (task M3.2). Chưa có hàng đợi: mỗi lần gửi lại toàn bộ session
//! trong phạm vi; server idempotent nên an toàn (M2.3/M3.1 sẽ chỉ gửi phần mới).

use std::collections::HashMap;
use std::io::Write;
use std::time::SystemTime;

use clap::Args;

use crate::consent;
use crate::context::AppContext;
use crate::error::AppError;
use crate::pipeline::batch::MAX_BATCH_JSON_BYTES;
use crate::pipeline::collect::{CollectStats, Pipeline};
use crate::pipeline::prepare::build_redactor;
use crate::pipeline::scope::ScopeFilter;
use crate::sync::agent_config::{self, ConfigSource};
use crate::sync::{connect, consent_gate, dashboard_link, send_all, SendReport, Sources};

/// Số link dashboard in tối đa sau khi gửi.
const MAX_LINKS: usize = 5;

#[derive(Debug, Args)]
pub struct SyncArgs {
    /// Quét và gửi một lần rồi thoát (mốc 1 luôn chạy một lần; chạy nền là `tl daemon`, task M3.2)
    #[arg(long)]
    pub once: bool,
    /// Chỉ in thống kê sẽ gửi, không gửi gì
    #[arg(long)]
    pub dry_run: bool,
}

pub async fn run(ctx: &AppContext, args: SyncArgs, out: &mut dyn Write) -> Result<(), AppError> {
    run_with(ctx, args, &Sources::from_env(), MAX_BATCH_JSON_BYTES, out).await
}

/// Như [`run`] nhưng nhận nguồn log và ngưỡng batch (để test).
pub async fn run_with(
    ctx: &AppContext,
    args: SyncArgs,
    sources: &Sources,
    max_batch_bytes: usize,
    out: &mut dyn Write,
) -> Result<(), AppError> {
    let _ = args.once; // Mốc 1: luôn một lần.
    if !args.dry_run && !consent_gate::may_send(ctx) {
        return Err(AppError::user(
            "Máy này chưa đồng ý chia sẻ dữ liệu với server hiện tại nên không gửi gì.",
            "Chạy `tl join <link mời>` (link do leader gửi) để xem và đồng ý.",
        ));
    }
    let conn = connect(ctx).await?;
    let local = ctx.load_config()?;
    let server_config = &conn.agent_config.config;
    print_config_source(out, &conn.agent_config.source);
    // Văn bản đồng ý đổi phiên bản hoặc tl quá cũ: không quét, không gửi gì.
    if let Err(block) = agent_config::check_send(&local, server_config, crate::CLI_VERSION) {
        if !args.dry_run {
            return Err(block.to_error());
        }
        let e = block.to_error();
        let _ = writeln!(out, "Lưu ý: {e} Gửi thật sẽ bị dừng.");
    }

    let prepare = agent_config::apply_to_prepare(&sources.prepare, server_config);
    let (redactor, warnings) = build_redactor(&prepare.server_redaction_patterns);
    for warning in &warnings {
        let _ = writeln!(out, "Cảnh báo: {warning}");
    }
    let mut filter = ScopeFilter::new(agent_config::repo_patterns(server_config));
    let mut pipeline = Pipeline {
        filter: &mut filter,
        redactor: &redactor,
        options: &prepare,
        now: SystemTime::now(),
    };
    let (mut prepared, stats) = pipeline.collect(&sources.adapter_refs());

    // Chỉ gửi session của project đã đồng ý; không backfill thì bỏ session cũ.
    let consent = consent::current(&local).cloned();
    let before = prepared.len();
    if let Some(state) = &consent {
        prepared.retain(|p| state.allows_session(&p.project_id, p.last_activity));
    }
    let skipped_by_consent = before - prepared.len();

    let turns: usize = prepared.iter().map(|p| p.envelope.turns.len()).sum();
    print_stats(out, &stats, turns);
    if skipped_by_consent > 0 {
        let _ = writeln!(
            out,
            "Bỏ {skipped_by_consent} session theo lựa chọn khi đồng ý (session cũ khi không gửi lịch sử, hoặc project chưa đồng ý)."
        );
    }
    if consent.is_none() {
        let _ = writeln!(
            out,
            "Máy này chưa đồng ý với server hiện tại: chạy `tl join <link mời>` trước khi gửi thật."
        );
    }

    if args.dry_run {
        let _ = writeln!(out, "Chạy thử (--dry-run): không gửi gì.");
        return Ok(());
    }
    if prepared.is_empty() {
        let _ = writeln!(out, "Không có session nào trong phạm vi để gửi.");
        return Ok(());
    }

    let project_of: HashMap<String, String> = prepared
        .iter()
        .map(|p| (p.envelope.session.source_id.clone(), p.project_id.clone()))
        .collect();
    let envelopes = prepared.into_iter().map(|p| p.envelope).collect();

    match send_all(&conn.client, envelopes, max_batch_bytes, ctx.poll_unit).await {
        Ok(report) => {
            print_report(out, &conn.server_url, &project_of, &report);
            Ok(())
        }
        Err((report, err)) => {
            if report.batches > 0 {
                print_report(out, &conn.server_url, &project_of, &report);
            }
            Err(err)
        }
    }
}

/// Báo khi đang dùng config cache (mất mạng lúc tải).
pub(crate) fn print_config_source(out: &mut dyn Write, source: &ConfigSource) {
    if let ConfigSource::Cache { fetched_at } = source {
        let _ = writeln!(
            out,
            "Không tải được cấu hình từ server, dùng bản đã lưu lúc {} (UTC).",
            fetched_at.format("%Y-%m-%d %H:%M")
        );
    }
}

fn print_stats(out: &mut dyn Write, s: &CollectStats, turns: usize) {
    let _ = writeln!(
        out,
        "Đã quét {} file log: {} session trong phạm vi ({} turn), {} session ngoài phạm vi bị bỏ (không gửi gì).",
        s.files, s.in_scope, turns, s.out_of_scope
    );
    if s.read_errors > 0 || s.parse_warnings > 0 {
        let _ = writeln!(
            out,
            "Cảnh báo: {} file không đọc được, {} bản ghi không nhận ra đã bỏ qua.",
            s.read_errors, s.parse_warnings
        );
    }
}

fn print_report(
    out: &mut dyn Write,
    server_url: &str,
    project_of: &HashMap<String, String>,
    r: &SendReport,
) {
    let turns: u64 = r.accepted.iter().map(|a| a.turns_upserted).sum();
    let _ = writeln!(
        out,
        "Đã gửi {} batch: server nhận {} session ({} turn được thêm/cập nhật), từ chối {}.",
        r.batches,
        r.accepted.len(),
        turns,
        r.rejected.len()
    );
    if r.duplicate_batches > 0 {
        let _ = writeln!(
            out,
            "({} batch server đã nhận từ trước, không ghi lại.)",
            r.duplicate_batches
        );
    }
    for rej in &r.rejected {
        let _ = writeln!(
            out,
            "  ✗ {}: {} ({})",
            rej.source_id, rej.message, rej.error
        );
    }
    let links: Vec<String> = r
        .accepted
        .iter()
        .filter_map(|a| {
            let project = project_of.get(&a.source_id)?;
            Some(dashboard_link(server_url, project, &a.session_id))
        })
        .collect();
    if !links.is_empty() {
        let _ = writeln!(out, "Xem trên dashboard:");
        for link in links.iter().take(MAX_LINKS) {
            let _ = writeln!(out, "  {link}");
        }
        if links.len() > MAX_LINKS {
            let _ = writeln!(out, "  … và {} session khác.", links.len() - MAX_LINKS);
        }
    }
}
