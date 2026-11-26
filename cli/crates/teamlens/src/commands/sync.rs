//! `tl sync` — quét log, lọc phạm vi, che secret, cắt rồi gửi ngay lên server.
//!
//! Mốc 1 (M1.7): chạy đúng một lần rồi thoát, cả khi không có `--once`. Chế độ chạy
//! lặp/nền là daemon (task M3.2). Chưa có hàng đợi: mỗi lần gửi lại toàn bộ session
//! trong phạm vi; server idempotent nên an toàn (M2.3/M3.1 sẽ chỉ gửi phần mới).

use std::collections::HashMap;
use std::io::Write;
use std::time::SystemTime;

use clap::Args;
use tl_core::redact::Redactor;

use crate::context::AppContext;
use crate::error::AppError;
use crate::pipeline::batch::MAX_BATCH_JSON_BYTES;
use crate::pipeline::collect::{CollectStats, Pipeline};
use crate::pipeline::scope::{patterns_from_whoami, ScopeFilter};
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
    let conn = connect(ctx).await?;

    let mut filter = ScopeFilter::new(patterns_from_whoami(&conn.whoami));
    let mut pipeline = Pipeline {
        filter: &mut filter,
        redactor: Redactor::shared(),
        options: &sources.prepare,
        now: SystemTime::now(),
    };
    let (prepared, stats) = pipeline.collect(&sources.adapter_refs());
    let turns: usize = prepared.iter().map(|p| p.envelope.turns.len()).sum();
    print_stats(out, &stats, turns);

    if args.dry_run {
        let _ = writeln!(out, "Chạy thử (--dry-run): không gửi gì.");
        return Ok(());
    }
    if prepared.is_empty() {
        let _ = writeln!(out, "Không có session nào trong phạm vi để gửi.");
        return Ok(());
    }
    if !consent_gate::may_send() {
        return Err(AppError::user(
            "Chưa được phép gửi dữ liệu (chưa đồng ý hoặc đang tạm dừng).",
            "Chạy `tl consent` hoặc `tl resume`.",
        ));
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
