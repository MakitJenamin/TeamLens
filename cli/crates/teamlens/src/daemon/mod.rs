//! Chế độ nền `tl daemon` (task M3.2, SPEC 4.2): tự thu thập và gửi, không cần `tl sync`.
//!
//! - **Một instance** cho mỗi thư mục dữ liệu: named mutex ([`instance`]).
//! - **Watch** thư mục log của mọi adapter bằng `notify` ([`watch`]); sự kiện được gom
//!   ([`schedule::Debouncer`]) tới khi file yên lặng 2 phút, rồi chạy một chu kỳ.
//! - **Quét lại** toàn bộ mỗi [`schedule::RESCAN_INTERVAL`] để không sót; tải lại config
//!   mỗi [`schedule::CONFIG_REFRESH_INTERVAL`] (mất mạng thì dùng cache).
//! - **Một chu kỳ** ([`run_cycle`]): consent gate → `check_send` → quét (như `tl sync`,
//!   chỉ file ổn định) → xếp hàng theo cụm → `queue::flush` với backoff của M3.1.
//!   Giữa hai chu kỳ không giữ session nào trong RAM.
//! - **Log** ra `daemon.log` trong thư mục dữ liệu ([`log`]), xoay vòng 5 MB.
//! - **Tắt êm**: Ctrl+C / đóng console / đăng xuất → dừng vòng, đóng `state.db`, nhả mutex.
//! - **Heartbeat** mỗi [`crate::heartbeat::HEARTBEAT_INTERVAL`] qua [`crate::heartbeat::send_once`]
//!   (M3.3). Đang `tl pause` thì chỉ heartbeat, không quét, không gửi.

pub mod instance;
pub mod log;
pub mod schedule;
pub mod watch;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use chrono::{DateTime, Utc};
use tracing_subscriber::fmt::writer::MakeWriterExt;

use crate::consent;
use crate::context::AppContext;
use crate::error::AppError;
use crate::heartbeat;
use crate::pipeline::collect::Pipeline;
use crate::pipeline::prepare::build_redactor;
use crate::pipeline::scope::ScopeFilter;
use crate::queue::{self, EnqueueReport, FlushOptions, FlushStop};
use crate::state::{state_path, StateDb};
use crate::sync::agent_config;
use crate::sync::incremental::{scope_fingerprint, FilePlan, PlannedSession};
use crate::sync::scan::{self, ScanOptions, ScanStats};
use crate::sync::{connect, consent_gate, Connected, Sources};

use schedule::{Debouncer, Schedule};

/// Khóa `meta` trong `state.db`: lúc daemon chạy xong chu kỳ gần nhất (RFC 3339), cho `tl status`.
pub const LAST_CYCLE_META_KEY: &str = "daemon_last_cycle_at";
/// Xếp hàng khi đã gom chừng này turn (giới hạn RAM lúc quét lần đầu nhiều file).
pub const ENQUEUE_CHUNK_TURNS: usize = 2_000;
/// … hoặc chừng này file.
pub const ENQUEUE_CHUNK_FILES: usize = 25;

/// Vì sao chu kỳ không quét/gửi.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CycleSkip {
    /// Máy chưa đồng ý với server hiện tại.
    NoConsent,
    /// Người dùng đã `tl pause` (M3.3).
    Paused,
    /// Config trên máy đã đổi sang server khác: cần kết nối lại.
    ServerChanged,
    /// `check_send` chặn: văn bản đồng ý đổi phiên bản hoặc `tl` quá cũ.
    Blocked(String),
}

/// Kết quả một chu kỳ.
#[derive(Debug, Default)]
pub struct CycleReport {
    pub skipped: Option<CycleSkip>,
    pub scan: ScanStats,
    /// Turn đưa vào kế hoạch gửi.
    pub planned_turns: usize,
    pub enqueued: EnqueueReport,
    pub sent_batches: usize,
    pub sent_turns: usize,
    pub failed_batches: usize,
    /// Lượt gửi dừng giữa chừng (thông điệp tiếng Việt).
    pub stop: Option<String>,
    /// Hàng đợi hẹn thử gửi lại lúc này.
    pub retry_at: Option<DateTime<Utc>>,
}

/// Cờ `tl pause` (M3.3, `meta.paused` trong `state.db`). Chưa có `state.db` thì không tạm dừng.
pub fn is_paused(ctx: &AppContext) -> Result<bool, AppError> {
    let path = state_path(&ctx.config_path);
    if !path.exists() {
        return Ok(false);
    }
    StateDb::open(&path)?.is_paused().map_err(state_err)
}

/// Gửi heartbeat (M3.3); lỗi chỉ ghi log (kết quả đã nằm trong `state.db` cho `tl status`).
async fn send_heartbeat(ctx: &AppContext, sources: &Sources, conn: Option<&Connected>) {
    let owned;
    let client = match conn {
        Some(c) => &c.client,
        None => match heartbeat::client_for(ctx) {
            Ok(Some(c)) => {
                owned = c;
                &owned
            }
            _ => return,
        },
    };
    match heartbeat::send_once(ctx, client, sources).await {
        Ok(r) => tracing::debug!(status = %r.status, "đã gửi heartbeat"),
        Err(e) => tracing::warn!("gửi heartbeat lỗi: {e}"),
    }
}

fn state_err(e: rusqlite::Error) -> AppError {
    tracing::warn!(error = %e, "lỗi state.db");
    AppError::user(
        "Không đọc/ghi được state.db.",
        "Kiểm tra quyền ghi thư mục dữ liệu TeamLens.",
    )
}

fn add_enqueue(total: &mut EnqueueReport, r: &EnqueueReport) {
    total.batches += r.batches;
    total.bytes += r.bytes;
    total.turns += r.turns;
    total.dropped += r.dropped;
}

/// Một chu kỳ của daemon: quét → prepare → xếp hàng → gửi. Không phụ thuộc thời gian
/// thật ngoài `now` (dùng để xét file ổn định và hạn backoff).
pub async fn run_cycle(
    ctx: &AppContext,
    sources: &Sources,
    conn: &Connected,
    now: SystemTime,
    max_batch_bytes: usize,
) -> Result<CycleReport, AppError> {
    let mut report = CycleReport::default();
    if !consent_gate::may_send(ctx) {
        report.skipped = Some(CycleSkip::NoConsent);
        return Ok(report);
    }
    if is_paused(ctx)? {
        report.skipped = Some(CycleSkip::Paused);
        return Ok(report);
    }
    let local = ctx.load_config()?;
    if local.server_url.as_deref() != Some(conn.server_url.as_str()) {
        report.skipped = Some(CycleSkip::ServerChanged);
        return Ok(report);
    }
    let server_config = &conn.agent_config.config;
    if let Err(block) = agent_config::check_send(&local, server_config, crate::CLI_VERSION) {
        report.skipped = Some(CycleSkip::Blocked(block.to_error().to_string()));
        return Ok(report);
    }

    let prepare = agent_config::apply_to_prepare(&sources.prepare, server_config);
    let (redactor, warnings) = build_redactor(&prepare.server_redaction_patterns);
    for warning in &warnings {
        tracing::warn!("{warning}");
    }
    let mut filter = ScopeFilter::new(agent_config::repo_patterns(server_config));
    let consent = consent::current(&local).cloned();

    let mut db = StateDb::open(&state_path(&ctx.config_path))?;
    let fingerprint = scope_fingerprint(&conn.server_url, server_config, consent.as_ref());
    if scan::scope_changed(&db, &fingerprint).map_err(state_err)? {
        tracing::info!("phạm vi gửi đổi (server, repo pattern hoặc đồng ý): xét lại mọi file");
        scan::reset_scope(&mut db, &fingerprint).map_err(state_err)?;
    }

    let mut pipeline = Pipeline {
        filter: &mut filter,
        redactor: &redactor,
        options: &prepare,
        now,
    };
    // Xếp hàng theo cụm để không giữ session của mọi file trong RAM.
    let mut pending: Vec<FilePlan> = Vec::new();
    let mut pending_turns = 0usize;
    let mut enqueued = EnqueueReport::default();
    let mut planned_turns = 0usize;
    let scanned = scan::scan(
        &mut db,
        sources,
        &mut pipeline,
        consent.as_ref(),
        ScanOptions {
            include_active: false,
            ignore_state: false,
            record_meta: true,
        },
        &mut |db, plan| {
            let turns: usize = plan.sessions.iter().map(PlannedSession::turn_count).sum();
            pending_turns += turns;
            planned_turns += turns;
            pending.push(plan);
            if pending_turns >= ENQUEUE_CHUNK_TURNS || pending.len() >= ENQUEUE_CHUNK_FILES {
                let r = queue::enqueue(db, &pending, max_batch_bytes)?;
                add_enqueue(&mut enqueued, &r);
                pending.clear();
                pending_turns = 0;
            }
            Ok(())
        },
    )
    .map_err(state_err)?;
    if !pending.is_empty() {
        let r = queue::enqueue(&mut db, &pending, max_batch_bytes).map_err(state_err)?;
        add_enqueue(&mut enqueued, &r);
    }
    drop(pending);
    report.scan = scanned;
    report.planned_turns = planned_turns;
    report.enqueued = enqueued;

    let flushed = queue::flush(
        ctx,
        &mut db,
        &conn.client,
        server_config,
        &FlushOptions::background(now),
    )
    .await
    .map_err(state_err)?;
    report.sent_batches = flushed.sent_batches;
    report.sent_turns = flushed.sent_turns;
    report.failed_batches = flushed.failed.len();
    match flushed.stop {
        None => {}
        Some(FlushStop::Waiting { next_attempt_at }) => report.retry_at = Some(next_attempt_at),
        Some(FlushStop::Retry {
            error,
            next_attempt_at,
        }) => {
            report.stop = Some(error.to_string());
            report.retry_at = Some(next_attempt_at);
        }
        Some(FlushStop::UpgradeRequired(e) | FlushStop::Blocked(e)) => {
            report.stop = Some(e.to_string());
        }
    }
    let stamp: DateTime<Utc> = now.into();
    db.set_meta(LAST_CYCLE_META_KEY, &stamp.to_rfc3339())
        .map_err(state_err)?;
    Ok(report)
}

/// Thời điểm chu kỳ gần nhất của daemon (đọc từ `state.db`), cho `tl status`.
pub fn last_cycle_at(ctx: &AppContext) -> Option<DateTime<Utc>> {
    let path = state_path(&ctx.config_path);
    if !path.exists() {
        return None;
    }
    let db = StateDb::open(&path).ok()?;
    let text = db.meta(LAST_CYCLE_META_KEY).ok()??;
    DateTime::parse_from_rfc3339(&text)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

fn log_cycle(r: &CycleReport) {
    if let Some(skip) = &r.skipped {
        match skip {
            CycleSkip::NoConsent => {
                tracing::info!("máy chưa đồng ý với server hiện tại: không quét, không gửi")
            }
            CycleSkip::Paused => tracing::info!("đang tạm dừng (tl pause): không quét, không gửi"),
            CycleSkip::ServerChanged => tracing::info!("server trong config đã đổi: kết nối lại"),
            CycleSkip::Blocked(m) => tracing::warn!("không gửi: {m}"),
        }
        return;
    }
    let s = &r.scan;
    let busy = s.collect.files > 0 || r.enqueued.batches > 0 || r.sent_batches > 0;
    if busy || r.stop.is_some() {
        tracing::info!(
            files_read = s.collect.files,
            in_scope = s.collect.in_scope,
            out_of_scope = s.collect.out_of_scope,
            unchanged = s.unchanged,
            waiting = s.waiting,
            skipped_by_consent = s.skipped_by_consent,
            planned_turns = r.planned_turns,
            enqueued_batches = r.enqueued.batches,
            dropped_batches = r.enqueued.dropped,
            sent_batches = r.sent_batches,
            sent_turns = r.sent_turns,
            failed_batches = r.failed_batches,
            "xong một chu kỳ"
        );
    } else {
        tracing::debug!(
            unchanged = s.unchanged,
            waiting = s.waiting,
            "xong một chu kỳ, không có gì mới"
        );
    }
    if let Some(stop) = &r.stop {
        match r.retry_at {
            Some(t) => tracing::warn!(retry_at = %t, "gửi chưa xong: {stop}"),
            None => tracing::warn!("gửi chưa xong: {stop}"),
        }
    }
}

/// Đổi mốc hẹn của hàng đợi thành khoảng chờ tính từ bây giờ.
fn retry_after(at: Option<DateTime<Utc>>) -> Option<Duration> {
    let at = at?;
    Some((at - Utc::now()).to_std().unwrap_or(Duration::ZERO))
}

/// Chờ tín hiệu dừng: Ctrl+C, Ctrl+Break, đóng console, đăng xuất, tắt máy.
async fn shutdown_signal() {
    #[cfg(windows)]
    {
        use tokio::signal::windows;
        let (Ok(mut c), Ok(mut brk), Ok(mut close), Ok(mut logoff), Ok(mut shutdown)) = (
            windows::ctrl_c(),
            windows::ctrl_break(),
            windows::ctrl_close(),
            windows::ctrl_logoff(),
            windows::ctrl_shutdown(),
        ) else {
            let _ = tokio::signal::ctrl_c().await;
            return;
        };
        tokio::select! {
            _ = c.recv() => {}
            _ = brk.recv() => {}
            _ = close.recv() => {}
            _ = logoff.recv() => {}
            _ = shutdown.recv() => {}
        }
    }
    #[cfg(not(windows))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Kết nối server (config + token); lỗi thì ghi log, trả `None`.
async fn try_connect(ctx: &AppContext) -> Option<Connected> {
    match connect(ctx).await {
        Ok(c) => {
            if let agent_config::ConfigSource::Cache { fetched_at } = &c.agent_config.source {
                tracing::warn!(%fetched_at, "không tải được config từ server, dùng bản cache");
            } else {
                tracing::info!(server = %c.server_url, "đã tải config từ server");
            }
            Some(c)
        }
        Err(e) => {
            tracing::warn!("chưa kết nối được server: {e}");
            None
        }
    }
}

/// Vòng chính của daemon, chạy tới khi `shutdown` xong.
pub async fn run_loop(
    ctx: &AppContext,
    sources: &Sources,
    max_batch_bytes: usize,
    shutdown: impl std::future::Future<Output = ()>,
) {
    let dirs: Vec<PathBuf> = sources
        .adapter_refs()
        .iter()
        .flat_map(|a| a.watch_dirs())
        .collect();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
    let mut watcher = watch::LogWatcher::new(dirs, tx);
    let mut debouncer = Debouncer::default();
    let mut sched = Schedule::new(Instant::now());
    let mut conn: Option<Connected> = None;
    // Không tạo được watcher thì kênh đóng ngay: thôi nghe, chỉ quét định kỳ.
    let mut events_open = true;
    tokio::pin!(shutdown);

    loop {
        let wake = sched.next_wake(debouncer.due_at());
        tokio::select! {
            _ = &mut shutdown => break,
            ev = rx.recv(), if events_open => {
                match ev {
                    Some(path) => debouncer.record(path, Instant::now()),
                    None => events_open = false,
                }
                continue;
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(wake)) => {}
        }
        let now = Instant::now();

        // Server trong config đổi (vd. `tl join` server khác): kết nối lại ngay.
        let server_changed = match (&conn, ctx.load_config()) {
            (Some(c), Ok(cfg)) => cfg.server_url.as_deref() != Some(c.server_url.as_str()),
            _ => false,
        };
        if sched.config_due(now) || server_changed {
            let fresh = try_connect(ctx).await;
            let ok = fresh.is_some();
            if ok && conn.is_none() {
                sched.scan_now(now);
            }
            if fresh.is_some() || server_changed {
                conn = fresh;
            }
            sched.config_done(now, ok);
        }
        if sched.heartbeat_due(now) {
            send_heartbeat(ctx, sources, conn.as_ref()).await;
            sched.heartbeat_done(now);
        }
        if sched.scan_due(now) || debouncer.is_due(now) {
            watcher.refresh();
            let mut retry = None;
            if let Some(c) = &conn {
                let cycle = run_cycle(ctx, sources, c, SystemTime::now(), max_batch_bytes);
                tokio::select! {
                    _ = &mut shutdown => break,
                    r = cycle => match r {
                        Ok(r) => {
                            log_cycle(&r);
                            retry = retry_after(r.retry_at);
                        }
                        Err(e) => tracing::warn!("chu kỳ lỗi: {e}"),
                    },
                }
            } else {
                tracing::debug!("chưa kết nối server, bỏ qua chu kỳ");
            }
            debouncer.take_due(now);
            sched.scan_done(Instant::now(), retry);
        }
    }
}

/// Chạy daemon (đã lấy mutex, đã bật log).
pub async fn run(
    ctx: &AppContext,
    sources: &Sources,
    max_batch_bytes: usize,
) -> Result<(), AppError> {
    tracing::info!(
        version = crate::CLI_VERSION,
        pid = std::process::id(),
        "daemon bắt đầu"
    );
    run_loop(ctx, sources, max_batch_bytes, shutdown_signal()).await;
    tracing::info!("daemon dừng");
    Ok(())
}

/// Bật log của daemon ra file (và stderr khi chạy foreground) cho thread hiện tại.
/// Mức log theo `TL_LOG`, mặc định `info`.
pub fn init_log(
    data_dir: &std::path::Path,
    foreground: bool,
) -> Result<(tracing::subscriber::DefaultGuard, PathBuf), AppError> {
    let path = data_dir.join(log::LOG_FILE_NAME);
    let file = log::RotatingLog::open(&path, log::MAX_LOG_BYTES).map_err(|e| {
        AppError::user(
            format!("Không mở được file log {}: {e}", path.display()),
            "Kiểm tra quyền ghi thư mục dữ liệu TeamLens.",
        )
    })?;
    let filter = std::env::var("TL_LOG").unwrap_or_default();
    let env_filter =
        tracing_subscriber::EnvFilter::try_new(if filter.is_empty() { "info" } else { &filter })
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let file = Mutex::new(file);
    let builder = tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_ansi(false)
        .with_target(false);
    let guard = if foreground {
        tracing::subscriber::set_default(builder.with_writer(file.and(std::io::stderr)).finish())
    } else {
        tracing::subscriber::set_default(builder.with_writer(file).finish())
    };
    Ok((guard, path))
}
