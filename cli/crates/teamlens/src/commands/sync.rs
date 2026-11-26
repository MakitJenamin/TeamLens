//! `tl sync` — quét log, lọc phạm vi, che secret, cắt rồi gửi lên server.
//!
//! Chạy đúng một lần rồi thoát, cả khi không có `--once` (chạy nền là `tl daemon`, M3.2).
//! M2.3: chỉ gửi phần mới của mỗi file log theo `state.db` ([`crate::sync::incremental`]),
//! và chỉ gửi file đã ổn định (không đổi ≥ 2 phút) trừ khi có `--include-active`.
//! M3.1: phần đã che được xếp vào hàng đợi trong `state.db` rồi mới gửi
//! ([`crate::queue`]); gửi lỗi thì batch nằm lại hàng đợi, lần sau gửi lại đúng batch đó.
//! M3.3: đang `tl pause` thì không quét, không gửi; xong lượt gửi thì gửi một heartbeat.

use std::io::Write;
use std::time::SystemTime;

use clap::Args;

use crate::consent;
use crate::context::AppContext;
use crate::error::AppError;
use crate::heartbeat;
use crate::pipeline::batch::MAX_BATCH_JSON_BYTES;
use crate::pipeline::collect::{CollectStats, Pipeline};
use crate::pipeline::prepare::build_redactor;
use crate::pipeline::scope::ScopeFilter;
use crate::queue::{self, format_bytes, FlushOptions, FlushReport, FlushStop};
use crate::state::{state_path, StateDb};
use crate::sync::agent_config::{self, ConfigSource};
use crate::sync::incremental::{scope_fingerprint, FilePlan, PlannedSession};
use crate::sync::scan::{self, ScanOptions, ScanStats};
use crate::sync::{connect, consent_gate, dashboard_link, Sources};

/// Số link dashboard in tối đa sau khi gửi.
const MAX_LINKS: usize = 5;

#[derive(Debug, Args)]
pub struct SyncArgs {
    /// Quét và gửi một lần rồi thoát (lệnh này luôn chạy một lần; chạy nền là `tl daemon`, task M3.2)
    #[arg(long)]
    pub once: bool,
    /// Chỉ in thống kê sẽ gửi, không gửi gì
    #[arg(long)]
    pub dry_run: bool,
    /// Gửi cả session còn đang được ghi (file sửa chưa tới 2 phút), dùng khi thử tay
    #[arg(long)]
    pub include_active: bool,
}

pub async fn run(ctx: &AppContext, args: SyncArgs, out: &mut dyn Write) -> Result<(), AppError> {
    run_with(ctx, args, &Sources::from_env(), MAX_BATCH_JSON_BYTES, out).await
}

fn state_err(ctx: &AppContext) -> impl Fn(rusqlite::Error) -> AppError + '_ {
    move |e| {
        tracing::debug!(error = %e, "lỗi state.db");
        AppError::user(
            format!(
                "Không đọc/ghi được file trạng thái {}.",
                state_path(&ctx.config_path).display()
            ),
            "Kiểm tra quyền ghi thư mục dữ liệu TeamLens; nếu file hỏng có thể xóa state.db (lần sau gửi lại từ đầu, server không ghi trùng).",
        )
    }
}

/// Như [`run`] nhưng nhận nguồn log và ngưỡng batch (để test).
pub async fn run_with(
    ctx: &AppContext,
    args: SyncArgs,
    sources: &Sources,
    max_batch_bytes: usize,
    out: &mut dyn Write,
) -> Result<(), AppError> {
    let _ = args.once; // Luôn một lần.
    let state_file = state_path(&ctx.config_path);
    if state_file.exists()
        && StateDb::open(&state_file)?
            .is_paused()
            .map_err(state_err(ctx))?
    {
        let _ = writeln!(
            out,
            "TeamLens đang tạm dừng (`tl pause`): không quét, không gửi gì. Chạy `tl resume` để tiếp tục."
        );
        return Ok(());
    }
    if !args.dry_run && !consent_gate::may_send(ctx) {
        return Err(AppError::user(
            "Máy này chưa đồng ý chia sẻ dữ liệu với server hiện tại nên không gửi gì.",
            "Chạy `tl join <link mời>` (link do leader gửi) để xem và đồng ý.",
        ));
    }
    let result = sync_once(ctx, &args, sources, max_batch_bytes, out).await;
    if !args.dry_run {
        send_heartbeat(ctx, sources).await;
    }
    result
}

/// Heartbeat cuối lượt `tl sync`; lỗi chỉ ghi vào `state.db` (hiện ở `tl status`), không làm
/// lệnh thất bại.
async fn send_heartbeat(ctx: &AppContext, sources: &Sources) {
    let client = match heartbeat::client_for(ctx) {
        Ok(Some(c)) => c,
        _ => return,
    };
    if let Err(e) = heartbeat::send_once(ctx, &client, sources).await {
        tracing::debug!(error = %e, "heartbeat cuối tl sync thất bại");
    }
}

/// Một lượt quét + gửi (đã qua kiểm tra tạm dừng và đồng ý).
async fn sync_once(
    ctx: &AppContext,
    args: &SyncArgs,
    sources: &Sources,
    max_batch_bytes: usize,
    out: &mut dyn Write,
) -> Result<(), AppError> {
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
    let consent = consent::current(&local).cloned();

    let mut db = StateDb::open(&state_path(&ctx.config_path))?;
    // Phạm vi gửi đổi (server, repo pattern, đồng ý) → xét lại mọi file từ đầu.
    let fingerprint = scope_fingerprint(&conn.server_url, server_config, consent.as_ref());
    let scope_changed = scan::scope_changed(&db, &fingerprint).map_err(state_err(ctx))?;
    if scope_changed && !args.dry_run {
        // Batch cũ thuộc phạm vi cũ (có thể là server khác): bỏ, quét lại từ đầu.
        scan::reset_scope(&mut db, &fingerprint).map_err(state_err(ctx))?;
    }
    let mut pipeline = Pipeline {
        filter: &mut filter,
        redactor: &redactor,
        options: &prepare,
        now: SystemTime::now(),
    };
    let mut plans: Vec<FilePlan> = Vec::new();
    let scanned = scan::scan(
        &mut db,
        sources,
        &mut pipeline,
        consent.as_ref(),
        ScanOptions {
            include_active: args.include_active,
            // dry-run khi phạm vi đổi: xem như gửi lại từ đầu.
            ignore_state: scope_changed,
            record_meta: !args.dry_run,
        },
        &mut |_, plan| {
            plans.push(plan);
            Ok(())
        },
    )
    .map_err(state_err(ctx))?;
    let stats = &scanned.collect;
    let skipped_by_consent = scanned.skipped_by_consent;
    let dropped_paused = scanned.dropped_paused;

    let turns: usize = plans
        .iter()
        .flat_map(|p| &p.sessions)
        .map(PlannedSession::turn_count)
        .sum();
    print_stats(out, stats, turns);
    print_skips(out, &scanned);
    if skipped_by_consent > 0 {
        let _ = writeln!(
            out,
            "Bỏ {skipped_by_consent} session theo lựa chọn khi đồng ý (session cũ khi không gửi lịch sử, hoặc project chưa đồng ý)."
        );
    }
    if dropped_paused > 0 {
        let _ = writeln!(
            out,
            "Bỏ {dropped_paused} turn phát sinh trong lúc tạm dừng (`tl pause`): không bao giờ gửi."
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

    // Xếp hàng (cùng transaction với đặt chỗ tiến độ) rồi gửi cả hàng đợi, cũ trước.
    let enq = queue::enqueue(&mut db, &plans, max_batch_bytes).map_err(state_err(ctx))?;
    if enq.batches > 0 {
        let _ = writeln!(
            out,
            "Đã xếp hàng {} batch ({} turn, {}).",
            enq.batches,
            enq.turns,
            format_bytes(enq.bytes)
        );
    }
    if enq.dropped > 0 {
        let _ = writeln!(
            out,
            "Cảnh báo: hàng đợi vượt {}, đã bỏ {} batch cũ nhất.",
            format_bytes(queue::MAX_QUEUE_BYTES),
            enq.dropped
        );
    }
    let opts = FlushOptions {
        now: SystemTime::now(),
        ignore_backoff: true,
        rate_limit_wait: Some(ctx.poll_unit),
    };
    let report = queue::flush(ctx, &mut db, &conn.client, server_config, &opts)
        .await
        .map_err(state_err(ctx))?;
    if report.sent_batches > 0 || !report.failed.is_empty() {
        print_report(out, &conn.server_url, &report);
    } else if enq.batches == 0 && report.stop.is_none() {
        let _ = writeln!(out, "Không có session nào mới trong phạm vi để gửi.");
    }
    match report.stop {
        None => Ok(()),
        Some(stop) => {
            let stats = queue::queue_stats(&db).map_err(state_err(ctx))?;
            let when = match &stop {
                FlushStop::Retry {
                    next_attempt_at, ..
                } => format!(", tự thử lại lúc {}", queue::local_time(*next_attempt_at)),
                _ => String::new(),
            };
            let _ = writeln!(
                out,
                "Chưa gửi được: hàng đợi giữ {} batch ({}){when}; chạy lại `tl sync` để gửi tiếp.",
                stats.pending_batches,
                format_bytes(stats.pending_bytes)
            );
            Err(stop.into_error())
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

fn print_skips(out: &mut dyn Write, s: &ScanStats) {
    if s.unchanged > 0 {
        let _ = writeln!(
            out,
            "Bỏ qua {} file log không đổi từ lần gửi trước.",
            s.unchanged
        );
    }
    if s.waiting > 0 {
        let _ = writeln!(
            out,
            "{} file log đang được ghi (sửa chưa tới 2 phút): chờ lần sau, hoặc thêm `--include-active` để gửi luôn.",
            s.waiting
        );
    }
}

fn print_report(out: &mut dyn Write, server_url: &str, r: &FlushReport) {
    let turns: u64 = r.accepted.iter().map(|a| a.turns_upserted).sum();
    let _ = writeln!(
        out,
        "Đã gửi {} batch: server nhận {} session ({} turn được thêm/cập nhật), từ chối {}.",
        r.sent_batches,
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
    for reason in &r.failed {
        let _ = writeln!(
            out,
            "  ✗ 1 batch bị server từ chối, không gửi lại: {reason}"
        );
    }
    for rej in &r.rejected {
        let _ = writeln!(
            out,
            "  ✗ {}: {} ({})",
            rej.source_id, rej.message, rej.error
        );
    }
    // Một session có thể nằm ở nhiều batch (gửi lại turn cuối, chia nhỏ): in mỗi link một lần.
    let mut links: Vec<String> = Vec::new();
    for a in &r.accepted {
        if let Some(project) = r.project_of.get(&a.source_id) {
            let link = dashboard_link(server_url, project, &a.session_id);
            if !links.contains(&link) {
                links.push(link);
            }
        }
    }
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
