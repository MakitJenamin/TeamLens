//! Hàng đợi offline trong `state.db` (task M3.1, SPEC 4.4).
//!
//! Luồng: quét → prepare (lọc phạm vi, che secret, cắt) → [`enqueue`] → [`flush`].
//! Chỉ batch **đã che** mới được ghi xuống đĩa; nội dung chưa che không bao giờ vào đây.
//!
//! - **Xếp hàng** ([`enqueue`]): gom envelope thành batch (`batch_id` cố định từ lúc này),
//!   gzip, ghi vào `queue_batches`. Cùng transaction ghi "đặt chỗ" tiến độ của từng file
//!   (`queue_reservations`, nối với batch qua `queue_reservation_batches`). Offset thật
//!   (`source_files`/`source_sessions`) chỉ được chốt khi mọi batch của lần đặt chỗ đã
//!   xong; lần quét sau so với bản đặt chỗ ([`StateDb::effective_file`]) nên mất mạng
//!   nhiều lần quét liền cũng không xếp hàng lại cùng nội dung.
//! - **Gửi** ([`flush`]): hỏi consent trước, rồi gửi theo thứ tự cũ trước, giữ nguyên
//!   `batch_id` khi gửi lại (server idempotent).
//!   - `202`: xóa batch, chốt tiến độ các file đã đủ.
//!   - Lỗi mạng, `5xx`, `408`: tăng số lần thử, hẹn lần kế tiếp theo exponential backoff
//!     có jitter (trần [`MAX_BACKOFF`]), dừng lượt gửi (giữ thứ tự).
//!   - `429`: hẹn lại theo `Retry-After` (trần [`MAX_BACKOFF`]); `tl sync` chạy tay được
//!     phép chờ tại chỗ một lần ([`FlushOptions::rate_limit_wait`]).
//!   - `413`: chia đôi batch (theo session, rồi theo turn) thành hai batch mới đứng đúng
//!     chỗ cũ; một turn đơn lẻ vẫn quá lớn thì đánh dấu hỏng kèm lý do.
//!   - `426`: dừng, giữ nguyên hàng đợi, báo cần cập nhật `tl`.
//!   - `401`/`403`: dừng, giữ nguyên hàng đợi (token/đồng ý cần xử lý).
//!   - `4xx` khác (vd. `400` sai schema): chuyển batch sang trạng thái hỏng (bỏ nội dung,
//!     giữ lý do), không thử lại; đếm qua [`QueueStats::failed_batches`] để heartbeat báo.
//! - **Giới hạn** [`MAX_QUEUE_BYTES`]: vượt thì bỏ batch chờ cũ nhất, cộng dồn số batch bị
//!   bỏ vào `meta.queue_dropped_batches` ([`QueueStats::dropped_batches`]).
//!
//! Batch hỏng hoặc bị bỏ vẫn được coi là "xong" với tiến độ đặt chỗ: offset vẫn tiến
//! (không đọc lại rồi lỗi lại mãi), phần dữ liệu đó mất và được đếm để báo.
//!
//! API cho daemon (M3.2) và heartbeat (M3.3): [`enqueue`], [`flush`], [`queue_stats`],
//! [`clear`].

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;
use tl_core::session::{IngestBatch, SessionEnvelope};

use crate::api_client::{
    AgentConfig, ApiClient, ApiError, IngestAccepted, IngestError, IngestRejected,
};
use crate::context::AppContext;
use crate::error::AppError;
use crate::pipeline::batch::{group_envelopes, gzip_json, new_batch};
use crate::state::{path_key, save_file_tx, FileState, StateDb};
use crate::sync::incremental::FilePlan;
use crate::sync::{agent_config, consent_gate, ingest_app_error};

/// Dung lượng tối đa của các batch chờ gửi (SPEC 4.4).
pub const MAX_QUEUE_BYTES: u64 = 500 * 1024 * 1024;
/// Khoảng chờ trước lần thử lại thứ hai (sau đó nhân đôi mỗi lần).
pub const BASE_BACKOFF: Duration = Duration::from_secs(30);
/// Trần khoảng chờ giữa hai lần thử (SPEC 4.4: tối đa 30 phút).
pub const MAX_BACKOFF: Duration = Duration::from_secs(30 * 60);
/// Khóa `meta` cộng dồn số batch bị bỏ vì hàng đợi đầy.
pub const DROPPED_META_KEY: &str = "queue_dropped_batches";

/// Server không gửi `Retry-After` thì chờ chừng này (giây).
const DEFAULT_RETRY_AFTER_SECS: u64 = 30;
/// `tl sync` chạy tay chỉ chờ tại chỗ khi `Retry-After` không quá chừng này (giây).
const MAX_INLINE_RETRY_AFTER_SECS: u64 = 120;

const STATUS_PENDING: &str = "pending";
const STATUS_FAILED: &str = "failed";

/// Kết quả một lần xếp hàng.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnqueueReport {
    /// Số batch mới ghi vào hàng đợi.
    pub batches: usize,
    /// Tổng byte (gzip) của các batch mới.
    pub bytes: u64,
    /// Số turn trong các batch mới.
    pub turns: usize,
    /// Số batch cũ nhất bị bỏ vì vượt [`MAX_QUEUE_BYTES`] ở lần này.
    pub dropped: usize,
}

/// Tiến độ một file cần chốt khi các batch chứa session của nó đã xong.
#[derive(Debug, Clone)]
pub struct Reservation {
    pub path: PathBuf,
    pub state: FileState,
    /// `source_id` các session của file có trong lần xếp hàng này.
    pub source_ids: Vec<String>,
}

/// Xếp hàng kết quả quét (mọi `FilePlan`, kể cả file không có gì để gửi) với giới hạn
/// [`MAX_QUEUE_BYTES`]. Một transaction: batch + đặt chỗ tiến độ.
pub fn enqueue(
    db: &mut StateDb,
    plans: &[FilePlan],
    max_batch_bytes: usize,
) -> rusqlite::Result<EnqueueReport> {
    enqueue_with_limit(db, plans, max_batch_bytes, MAX_QUEUE_BYTES)
}

/// Như [`enqueue`] nhưng nhận giới hạn dung lượng (để test).
pub fn enqueue_with_limit(
    db: &mut StateDb,
    plans: &[FilePlan],
    max_batch_bytes: usize,
    max_queue_bytes: u64,
) -> rusqlite::Result<EnqueueReport> {
    let mut envelopes = Vec::new();
    let mut projects = HashMap::new();
    for s in plans.iter().flat_map(|p| &p.sessions) {
        if s.turn_count() == 0 {
            // Mọi turn mới đều trong lúc `tl pause` (M3.3): không gửi; đặt chỗ không có
            // batch nào nên tiến độ được ghi ngay.
            continue;
        }
        projects.insert(s.progress.source_id.clone(), s.prepared.project_id.clone());
        envelopes.push(s.prepared.envelope.clone());
    }
    let reservations = plans
        .iter()
        .map(|p| Reservation {
            path: p.file.path.clone(),
            state: p.target_state(),
            source_ids: p
                .sessions
                .iter()
                .map(|s| s.progress.source_id.clone())
                .collect(),
        })
        .collect();
    enqueue_envelopes(
        db,
        envelopes,
        &projects,
        reservations,
        max_batch_bytes,
        max_queue_bytes,
    )
}

/// Batch đã đóng gói, chưa ghi.
struct Built {
    batch_id: String,
    body: Vec<u8>,
    turns: usize,
    source_ids: HashSet<String>,
    projects: String,
}

fn build(
    group: Vec<SessionEnvelope>,
    projects: &HashMap<String, String>,
) -> rusqlite::Result<Built> {
    let source_ids: HashSet<String> = group.iter().map(|e| e.session.source_id.clone()).collect();
    let turns = group.iter().map(|e| e.turns.len()).sum();
    let proj: BTreeMap<&str, &str> = source_ids
        .iter()
        .filter_map(|id| Some((id.as_str(), projects.get(id)?.as_str())))
        .collect();
    let projects = serde_json::to_string(&proj).map_err(conv_err)?;
    let batch = new_batch(group);
    let body = gzip_json(&batch).map_err(conv_err)?;
    Ok(Built {
        batch_id: batch.batch_id.to_string(),
        body,
        turns,
        source_ids,
        projects,
    })
}

/// Tầng thấp của [`enqueue`]: envelope đã che + bản đặt chỗ tiến độ.
pub fn enqueue_envelopes(
    db: &mut StateDb,
    envelopes: Vec<SessionEnvelope>,
    projects: &HashMap<String, String>,
    reservations: Vec<Reservation>,
    max_batch_bytes: usize,
    max_queue_bytes: u64,
) -> rusqlite::Result<EnqueueReport> {
    // Nén ngoài transaction để giữ khóa ghi ngắn.
    let built = group_envelopes(envelopes, max_batch_bytes)
        .into_iter()
        .map(|g| build(g, projects))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut report = EnqueueReport::default();
    let tx = db.conn.transaction()?;
    for b in &built {
        insert_batch(&tx, b, None)?;
        report.batches += 1;
        report.bytes += b.body.len() as u64;
        report.turns += b.turns;
    }
    for r in reservations {
        let state = serde_json::to_string(&r.state).map_err(conv_err)?;
        tx.execute(
            "INSERT INTO queue_reservations (path, state, created_at) VALUES (?1, ?2, ?3)",
            params![path_key(&r.path), state, now_text()],
        )?;
        let rid = tx.last_insert_rowid();
        for b in built
            .iter()
            .filter(|b| r.source_ids.iter().any(|id| b.source_ids.contains(id)))
        {
            tx.execute(
                "INSERT OR IGNORE INTO queue_reservation_batches (reservation_id, batch_id)
                 VALUES (?1, ?2)",
                params![rid, b.batch_id],
            )?;
        }
    }
    report.dropped = enforce_limit(&tx, max_queue_bytes)?;
    apply_resolved(&tx)?;
    tx.commit()?;
    Ok(report)
}

/// Ghi một batch; `ord = None` → đứng cuối hàng.
fn insert_batch(tx: &Transaction<'_>, b: &Built, ord: Option<i64>) -> rusqlite::Result<()> {
    let ord = match ord {
        Some(o) => o,
        None => tx.query_row(
            "SELECT COALESCE(MAX(ord), 0) + 1 FROM queue_batches",
            [],
            |r| r.get(0),
        )?,
    };
    tx.execute(
        "INSERT INTO queue_batches
            (batch_id, ord, status, body, size_bytes, turns, projects, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            b.batch_id,
            ord,
            STATUS_PENDING,
            b.body,
            b.body.len() as i64,
            b.turns as i64,
            b.projects,
            now_text()
        ],
    )?;
    Ok(())
}

/// Bỏ batch chờ cũ nhất tới khi tổng dung lượng ≤ `max_bytes`. Trả số batch đã bỏ.
fn enforce_limit(tx: &Transaction<'_>, max_bytes: u64) -> rusqlite::Result<usize> {
    let mut dropped = 0usize;
    loop {
        let total: i64 = tx.query_row(
            "SELECT COALESCE(SUM(size_bytes), 0) FROM queue_batches WHERE status = ?1",
            [STATUS_PENDING],
            |r| r.get(0),
        )?;
        if total as u64 <= max_bytes {
            break;
        }
        let oldest: Option<String> = tx
            .query_row(
                "SELECT batch_id FROM queue_batches WHERE status = ?1 ORDER BY ord, id LIMIT 1",
                [STATUS_PENDING],
                |r| r.get(0),
            )
            .optional()?;
        let Some(id) = oldest else { break };
        tx.execute("DELETE FROM queue_batches WHERE batch_id = ?1", [&id])?;
        dropped += 1;
    }
    if dropped > 0 {
        tracing::warn!(dropped, "hàng đợi vượt giới hạn, bỏ batch cũ nhất");
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET
                value = CAST(CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER) AS TEXT)",
            params![DROPPED_META_KEY, dropped.to_string()],
        )?;
    }
    Ok(dropped)
}

/// Chốt tiến độ của các lần đặt chỗ đã xong (không còn batch chờ), theo thứ tự cũ trước
/// cho từng file: lần đặt chỗ sau chỉ chốt khi các lần trước của cùng file đã chốt.
fn apply_resolved(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let rows: Vec<(i64, String, String, bool)> = {
        let mut stmt = tx.prepare(
            "SELECT r.id, r.path, r.state, NOT EXISTS (
                SELECT 1 FROM queue_reservation_batches rb
                JOIN queue_batches b ON b.batch_id = rb.batch_id
                WHERE rb.reservation_id = r.id AND b.status = ?1)
             FROM queue_reservations r ORDER BY r.id",
        )?;
        let rows = stmt.query_map([STATUS_PENDING], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut blocked: HashSet<String> = HashSet::new();
    for (id, path, state, resolved) in rows {
        if blocked.contains(&path) {
            continue;
        }
        if !resolved {
            blocked.insert(path);
            continue;
        }
        let state: FileState = serde_json::from_str(&state).map_err(conv_err)?;
        save_file_tx(tx, Path::new(&path), &state)?;
        tx.execute("DELETE FROM queue_reservations WHERE id = ?1", [id])?;
    }
    // Liên kết tới batch đã xóa (đã gửi/bị bỏ) mà lần đặt chỗ còn chờ batch khác: giữ
    // lại cũng không sai, nhưng dọn cho gọn.
    tx.execute(
        "DELETE FROM queue_reservation_batches
         WHERE batch_id NOT IN (SELECT batch_id FROM queue_batches)
           AND reservation_id NOT IN (SELECT id FROM queue_reservations)",
        [],
    )?;
    Ok(())
}

/// Xóa toàn bộ hàng đợi (batch, kể cả batch hỏng, và tiến độ đặt chỗ). Dùng khi phạm vi
/// gửi đổi (server, repo pattern, đồng ý) hoặc rút đồng ý/gỡ cài đặt. Số đếm batch bị
/// bỏ vẫn giữ.
pub fn clear(db: &mut StateDb) -> rusqlite::Result<()> {
    let tx = db.conn.transaction()?;
    tx.execute("DELETE FROM queue_reservations", [])?;
    tx.execute("DELETE FROM queue_reservation_batches", [])?;
    tx.execute("DELETE FROM queue_batches", [])?;
    tx.commit()
}

/// Số liệu hàng đợi cho `tl status` và heartbeat (M3.3).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStats {
    /// Số batch đang chờ gửi.
    pub pending_batches: u64,
    /// Tổng byte (gzip) của các batch chờ gửi.
    pub pending_bytes: u64,
    /// Số batch hỏng (server từ chối vĩnh viễn, vd. `400`), không gửi lại.
    pub failed_batches: u64,
    /// Tổng số batch đã bị bỏ vì hàng đợi đầy (cộng dồn).
    pub dropped_batches: u64,
    /// Lần thử kế tiếp của batch đầu hàng, nếu đang chờ backoff.
    pub next_attempt_at: Option<DateTime<Utc>>,
    /// Lỗi lần gửi cuối của batch đầu hàng.
    pub last_error: Option<String>,
}

/// Đọc số liệu hàng đợi (chỉ đọc).
pub fn queue_stats(db: &StateDb) -> rusqlite::Result<QueueStats> {
    let (pending_batches, pending_bytes): (i64, i64) = db.conn.query_row(
        "SELECT count(*), COALESCE(SUM(size_bytes), 0) FROM queue_batches WHERE status = ?1",
        [STATUS_PENDING],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let failed_batches: i64 = db.conn.query_row(
        "SELECT count(*) FROM queue_batches WHERE status = ?1",
        [STATUS_FAILED],
        |r| r.get(0),
    )?;
    let dropped_batches = db
        .meta(DROPPED_META_KEY)?
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let head: Option<(i64, i64, Option<String>)> = db
        .conn
        .query_row(
            "SELECT attempts, next_attempt_ms, last_error FROM queue_batches
             WHERE status = ?1 ORDER BY ord, id LIMIT 1",
            [STATUS_PENDING],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (next_attempt_at, last_error) = match head {
        Some((attempts, next_ms, err)) if attempts > 0 => {
            (DateTime::<Utc>::from_timestamp_millis(next_ms), err)
        }
        Some((_, _, err)) => (None, err),
        None => (None, None),
    };
    Ok(QueueStats {
        pending_batches: pending_batches as u64,
        pending_bytes: pending_bytes as u64,
        failed_batches: failed_batches as u64,
        dropped_batches,
        next_attempt_at,
        last_error,
    })
}

/// Một batch chờ gửi (không kèm nội dung).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingBatch {
    pub batch_id: String,
    pub size_bytes: u64,
    pub turns: usize,
    pub attempts: u32,
    pub next_attempt_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

/// Các batch chờ gửi theo thứ tự gửi.
pub fn list_pending(db: &StateDb) -> rusqlite::Result<Vec<PendingBatch>> {
    let mut stmt = db.conn.prepare(
        "SELECT batch_id, size_bytes, turns, attempts, next_attempt_ms, last_error
         FROM queue_batches WHERE status = ?1 ORDER BY ord, id",
    )?;
    let rows = stmt.query_map([STATUS_PENDING], |r| {
        let attempts = r.get::<_, i64>(3)? as u32;
        let next: i64 = r.get(4)?;
        Ok(PendingBatch {
            batch_id: r.get(0)?,
            size_bytes: r.get::<_, i64>(1)? as u64,
            turns: r.get::<_, i64>(2)? as usize,
            attempts,
            next_attempt_at: (attempts > 0).then(|| from_millis(next)),
            last_error: r.get(5)?,
        })
    })?;
    rows.collect()
}

/// Khoảng chờ trước lần thử thứ `attempts + 1` (`attempts` ≥ 1 là số lần đã thất bại):
/// `BASE_BACKOFF · 2^(attempts-1)`, trần [`MAX_BACKOFF`], nhân hệ số jitter trong
/// `[0.5, 1]` (`jitter` ∈ `[0, 1]`) để nhiều máy không cùng thử lại một lúc.
pub fn backoff_delay(attempts: u32, jitter: f64) -> Duration {
    let exp = attempts.saturating_sub(1).min(16);
    let raw = BASE_BACKOFF.saturating_mul(1u32 << exp).min(MAX_BACKOFF);
    raw.mul_f64(0.5 + 0.5 * jitter.clamp(0.0, 1.0))
}

/// Số ngẫu nhiên trong `[0, 1]` (đủ cho jitter, không cần crate `rand`).
fn random_unit() -> f64 {
    uuid::Uuid::new_v4().as_u128() as f64 / u128::MAX as f64
}

/// Tùy chọn một lượt gửi.
#[derive(Debug, Clone)]
pub struct FlushOptions {
    pub now: SystemTime,
    /// Gửi luôn cả batch chưa tới giờ thử lại (`tl sync` chạy tay). Daemon để `false`.
    pub ignore_backoff: bool,
    /// Gặp `429` lần đầu thì chờ `Retry-After` giây (mỗi "giây" là khoảng này) rồi thử
    /// lại tại chỗ; `None` → hẹn lại theo `Retry-After` và dừng lượt gửi.
    pub rate_limit_wait: Option<Duration>,
}

impl FlushOptions {
    /// Cho daemon: tôn trọng backoff, không chờ tại chỗ.
    pub fn background(now: SystemTime) -> Self {
        Self {
            now,
            ignore_backoff: false,
            rate_limit_wait: None,
        }
    }
}

/// Lý do lượt gửi dừng trước khi hết hàng đợi. Hàng đợi luôn được giữ nguyên.
#[derive(Debug)]
pub enum FlushStop {
    /// Batch đầu hàng chưa tới giờ thử lại (backoff).
    Waiting { next_attempt_at: DateTime<Utc> },
    /// Lỗi tạm (mạng, `5xx`, `429`): đã hẹn lần thử kế tiếp.
    Retry {
        error: AppError,
        next_attempt_at: DateTime<Utc>,
    },
    /// `426` hoặc `min_cli_version` cao hơn bản đang chạy: cần cập nhật `tl` (M5.3).
    UpgradeRequired(AppError),
    /// Không được gửi: chưa đồng ý/đồng ý cũ, token hết hiệu lực (`401`/`403`).
    Blocked(AppError),
}

impl FlushStop {
    /// Lỗi cho người dùng (`tl sync` trả về).
    pub fn into_error(self) -> AppError {
        match self {
            FlushStop::Waiting { next_attempt_at } => AppError::user(
                format!("Chưa gửi, sẽ thử lại lúc {}.", local_time(next_attempt_at)),
                "Gửi ngay: `tl sync`.",
            ),
            FlushStop::Retry { error, .. }
            | FlushStop::UpgradeRequired(error)
            | FlushStop::Blocked(error) => error,
        }
    }
}

/// Giờ địa phương dạng `dd/mm HH:MM`.
pub fn local_time(t: DateTime<Utc>) -> String {
    t.with_timezone(&chrono::Local)
        .format("%d/%m %H:%M")
        .to_string()
}

/// Kết quả một lượt gửi.
#[derive(Debug, Default)]
pub struct FlushReport {
    /// Số batch server đã nhận (`202`).
    pub sent_batches: usize,
    /// Trong số đó, batch server đã nhận từ trước (gửi lại sau khi mất phản hồi).
    pub duplicate_batches: usize,
    /// Số turn trong các batch đã gửi.
    pub sent_turns: usize,
    pub accepted: Vec<IngestAccepted>,
    pub rejected: Vec<IngestRejected>,
    /// `source_id` → project (để in link dashboard).
    pub project_of: HashMap<String, String>,
    /// Số batch vừa bị đánh dấu hỏng ở lượt này, kèm lý do.
    pub failed: Vec<String>,
    /// Số lần chia đôi do `413`.
    pub split_batches: usize,
    pub stop: Option<FlushStop>,
}

/// Một batch đọc từ hàng đợi.
struct Row {
    batch_id: String,
    ord: i64,
    body: Vec<u8>,
    turns: usize,
    projects: String,
    attempts: u32,
    next_attempt_ms: i64,
}

fn head(db: &StateDb) -> rusqlite::Result<Option<Row>> {
    db.conn
        .query_row(
            "SELECT batch_id, ord, body, turns, projects, attempts, next_attempt_ms
             FROM queue_batches WHERE status = ?1 ORDER BY ord, id LIMIT 1",
            [STATUS_PENDING],
            |r| {
                Ok(Row {
                    batch_id: r.get(0)?,
                    ord: r.get(1)?,
                    body: r.get(2)?,
                    turns: r.get::<_, i64>(3)? as usize,
                    projects: r.get(4)?,
                    attempts: r.get::<_, i64>(5)? as u32,
                    next_attempt_ms: r.get(6)?,
                })
            },
        )
        .optional()
}

/// Kiểm tra trước khi gửi: đồng ý cục bộ (module consent) và config server.
fn send_gate(ctx: &AppContext, server_config: &AgentConfig) -> Result<(), FlushStop> {
    if !consent_gate::may_send(ctx) {
        return Err(FlushStop::Blocked(AppError::user(
            "Máy này chưa đồng ý chia sẻ dữ liệu nên không gửi gì.",
            "Chạy `tl join <link mời>` để xem và đồng ý.",
        )));
    }
    let local = ctx.load_config().map_err(FlushStop::Blocked)?;
    agent_config::check_send(&local, server_config, crate::CLI_VERSION).map_err(|b| {
        let e = b.to_error();
        match b {
            agent_config::SendBlock::CliTooOld { .. } => FlushStop::UpgradeRequired(e),
            agent_config::SendBlock::ConsentOutdated { .. } => FlushStop::Blocked(e),
        }
    })
}

/// Gửi hàng đợi theo thứ tự cũ trước tới khi hết, hoặc gặp lỗi cần dừng
/// ([`FlushReport::stop`]). Luôn hỏi consent trước; không được gửi thì giữ hàng đợi.
/// Lỗi `state.db` trả `Err`.
pub async fn flush(
    ctx: &AppContext,
    db: &mut StateDb,
    client: &ApiClient,
    server_config: &AgentConfig,
    opts: &FlushOptions,
) -> rusqlite::Result<FlushReport> {
    let mut report = FlushReport::default();
    if head(db)?.is_none() {
        return Ok(report);
    }
    if let Err(stop) = send_gate(ctx, server_config) {
        report.stop = Some(stop);
        return Ok(report);
    }
    let now_ms = millis(opts.now);
    let mut waited_rate_limit = false;
    while let Some(row) = head(db)? {
        if !opts.ignore_backoff && row.next_attempt_ms > now_ms {
            report.stop = Some(FlushStop::Waiting {
                next_attempt_at: from_millis(row.next_attempt_ms),
            });
            break;
        }
        match client.ingest_gzip(row.body.clone()).await {
            Ok(result) => {
                let tx = db.conn.transaction()?;
                tx.execute(
                    "DELETE FROM queue_batches WHERE batch_id = ?1",
                    [&row.batch_id],
                )?;
                apply_resolved(&tx)?;
                tx.commit()?;
                report.sent_batches += 1;
                report.sent_turns += row.turns;
                if result.duplicate {
                    report.duplicate_batches += 1;
                }
                if let Ok(p) = serde_json::from_str::<HashMap<String, String>>(&row.projects) {
                    report.project_of.extend(p);
                }
                report.accepted.extend(result.accepted);
                report.rejected.extend(result.rejected);
            }
            Err(IngestError::TooLarge) => match split(&row.body) {
                Some(halves) => {
                    replace_with(db, &row, halves)?;
                    report.split_batches += 1;
                }
                None => {
                    let reason =
                        "413: một turn đơn lẻ vẫn vượt giới hạn kích thước của server".to_owned();
                    mark_failed(db, &row.batch_id, &reason)?;
                    report.failed.push(reason);
                }
            },
            Err(IngestError::RateLimited {
                retry_after,
                message,
            }) => {
                let secs = retry_after.unwrap_or(DEFAULT_RETRY_AFTER_SECS);
                if let Some(unit) = opts.rate_limit_wait {
                    if !waited_rate_limit && secs <= MAX_INLINE_RETRY_AFTER_SECS {
                        waited_rate_limit = true;
                        tracing::info!(secs, "server báo gửi quá nhanh, chờ rồi thử lại");
                        tokio::time::sleep(unit * secs as u32).await;
                        continue;
                    }
                }
                let delay = Duration::from_secs(secs).min(MAX_BACKOFF);
                let next = schedule_retry(db, &row, opts.now, delay, &format!("429: {message}"))?;
                report.stop = Some(FlushStop::Retry {
                    error: ingest_app_error(IngestError::RateLimited {
                        retry_after,
                        message,
                    }),
                    next_attempt_at: next,
                });
                break;
            }
            Err(e @ IngestError::UpgradeRequired { .. }) => {
                set_last_error(db, &row.batch_id, &e.to_string())?;
                report.stop = Some(FlushStop::UpgradeRequired(ingest_app_error(e)));
                break;
            }
            Err(IngestError::Api(e)) => match classify(&e) {
                ErrorKind::Transient => {
                    let delay = backoff_delay(row.attempts + 1, random_unit());
                    let next = schedule_retry(db, &row, opts.now, delay, &e.to_string())?;
                    report.stop = Some(FlushStop::Retry {
                        error: AppError::Api(e),
                        next_attempt_at: next,
                    });
                    break;
                }
                ErrorKind::Auth => {
                    set_last_error(db, &row.batch_id, &e.to_string())?;
                    report.stop = Some(FlushStop::Blocked(ingest_app_error(IngestError::Api(e))));
                    break;
                }
                ErrorKind::Permanent => {
                    let reason = e.to_string();
                    tracing::warn!(batch_id = %row.batch_id, %reason, "server từ chối batch, đánh dấu hỏng");
                    mark_failed(db, &row.batch_id, &reason)?;
                    report.failed.push(reason);
                }
            },
        }
    }
    Ok(report)
}

enum ErrorKind {
    /// Thử lại sau (mạng, `5xx`, `408`, phản hồi hỏng).
    Transient,
    /// `401`/`403`: dừng, chờ người dùng xử lý.
    Auth,
    /// `4xx` khác: dữ liệu sai, gửi lại cũng vậy.
    Permanent,
}

fn classify(e: &ApiError) -> ErrorKind {
    let status = match e {
        ApiError::Api { status, .. } | ApiError::InvalidResponse { status, .. } => *status,
        ApiError::Network { .. } | ApiError::Build(_) => return ErrorKind::Transient,
    };
    match status {
        401 | 403 => ErrorKind::Auth,
        408 => ErrorKind::Transient,
        400..=499 => ErrorKind::Permanent,
        // 2xx với JSON sai contract, 5xx, mã lạ: thử lại sau.
        _ => ErrorKind::Transient,
    }
}

/// Tăng số lần thử, hẹn lần kế tiếp sau `delay`. Trả thời điểm hẹn.
fn schedule_retry(
    db: &StateDb,
    row: &Row,
    now: SystemTime,
    delay: Duration,
    error: &str,
) -> rusqlite::Result<DateTime<Utc>> {
    let next = millis(now).saturating_add(i64::try_from(delay.as_millis()).unwrap_or(i64::MAX));
    db.conn.execute(
        "UPDATE queue_batches SET attempts = attempts + 1, next_attempt_ms = ?2, last_error = ?3
         WHERE batch_id = ?1",
        params![row.batch_id, next, error],
    )?;
    tracing::info!(batch_id = %row.batch_id, attempts = row.attempts + 1, delay_secs = delay.as_secs(), "gửi lỗi, hẹn thử lại");
    Ok(from_millis(next))
}

fn set_last_error(db: &StateDb, batch_id: &str, error: &str) -> rusqlite::Result<()> {
    db.conn.execute(
        "UPDATE queue_batches SET last_error = ?2 WHERE batch_id = ?1",
        params![batch_id, error],
    )?;
    Ok(())
}

/// Batch hỏng: bỏ nội dung (không gửi lại), giữ lý do để báo; chốt tiến độ liên quan.
fn mark_failed(db: &mut StateDb, batch_id: &str, reason: &str) -> rusqlite::Result<()> {
    let tx = db.conn.transaction()?;
    tx.execute(
        "UPDATE queue_batches SET status = ?2, body = x'', size_bytes = 0,
            attempts = attempts + 1, last_error = ?3
         WHERE batch_id = ?1",
        params![batch_id, STATUS_FAILED, reason],
    )?;
    apply_resolved(&tx)?;
    tx.commit()
}

/// Thay batch bị `413` bằng hai nửa đứng đúng chỗ cũ (cùng `ord`), chuyển liên kết đặt
/// chỗ sang hai nửa.
fn replace_with(db: &mut StateDb, row: &Row, halves: [IngestBatch; 2]) -> rusqlite::Result<()> {
    let mut built = Vec::with_capacity(2);
    for half in halves {
        let body = gzip_json(&half).map_err(conv_err)?;
        built.push(Built {
            batch_id: half.batch_id.to_string(),
            turns: half.sessions.iter().map(|s| s.turns.len()).sum(),
            body,
            source_ids: HashSet::new(),
            projects: row.projects.clone(),
        });
    }
    let tx = db.conn.transaction()?;
    for b in &built {
        insert_batch(&tx, b, Some(row.ord))?;
        tx.execute(
            "INSERT OR IGNORE INTO queue_reservation_batches (reservation_id, batch_id)
             SELECT reservation_id, ?2 FROM queue_reservation_batches WHERE batch_id = ?1",
            params![row.batch_id, b.batch_id],
        )?;
    }
    tx.execute(
        "DELETE FROM queue_reservation_batches WHERE batch_id = ?1",
        [&row.batch_id],
    )?;
    tx.execute(
        "DELETE FROM queue_batches WHERE batch_id = ?1",
        [&row.batch_id],
    )?;
    tx.commit()
}

/// Giải nén batch rồi chia đôi: nhiều session → theo session; một session → theo turn.
/// Mỗi nửa nhận `batch_id` mới (batch gốc chưa từng được server nhận).
fn split(body: &[u8]) -> Option<[IngestBatch; 2]> {
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(body)
        .read_to_end(&mut json)
        .ok()?;
    let batch: IngestBatch = serde_json::from_slice(&json).ok()?;
    let mut group = batch.sessions;
    let (a, b) = if group.len() > 1 {
        let b = group.split_off(group.len() / 2);
        (group, b)
    } else {
        let mut env = group.pop()?;
        if env.turns.len() <= 1 {
            return None;
        }
        let tail = env.turns.split_off(env.turns.len() / 2);
        let other = SessionEnvelope {
            session: env.session.clone(),
            turns: tail,
        };
        (vec![env], vec![other])
    };
    Some([new_batch(a), new_batch(b)])
}

/// Định dạng dung lượng cho người đọc (`512 B`, `3,4 KB`, `12,0 MB`).
pub fn format_bytes(n: u64) -> String {
    const KB: f64 = 1024.0;
    let v = n as f64;
    let s = if v < KB {
        format!("{n} B")
    } else if v < KB * KB {
        format!("{:.1} KB", v / KB)
    } else {
        format!("{:.1} MB", v / KB / KB)
    };
    s.replace('.', ",")
}

fn millis(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn from_millis(ms: i64) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default()
}

fn now_text() -> String {
    Utc::now().to_rfc3339()
}

fn conv_err(e: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_tang_gap_doi_co_tran_va_jitter() {
        assert_eq!(backoff_delay(1, 1.0), BASE_BACKOFF);
        assert_eq!(backoff_delay(2, 1.0), BASE_BACKOFF * 2);
        assert_eq!(backoff_delay(3, 1.0), BASE_BACKOFF * 4);
        assert_eq!(backoff_delay(1, 0.0), BASE_BACKOFF / 2);
        for attempts in [7, 10, 50, u32::MAX] {
            assert_eq!(backoff_delay(attempts, 1.0), MAX_BACKOFF);
            assert!(backoff_delay(attempts, 0.3) <= MAX_BACKOFF);
            assert!(backoff_delay(attempts, 0.0) >= MAX_BACKOFF / 2);
        }
        let r = random_unit();
        assert!((0.0..=1.0).contains(&r));
    }

    #[test]
    fn dinh_dang_dung_luong() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(3 * 1024 + 400), "3,4 KB");
        assert_eq!(format_bytes(12 * 1024 * 1024), "12,0 MB");
    }

    use crate::state::SessionProgress;
    use chrono::TimeZone;
    use tl_core::session::{AgentKind, Role, Session, Turn, TurnKind};

    fn env(id: &str, text_len: usize) -> SessionEnvelope {
        let ts = Utc.with_ymd_and_hms(2026, 11, 27, 9, 0, 0).unwrap();
        let mut t = Turn::new(0, Role::User, TurnKind::Prompt, ts);
        // Nội dung khó nén để kích thước gzip ổn định.
        t.text = Some(
            (0..text_len)
                .map(|i| char::from(b'a' + ((i * 7919 + id.len() * 31) % 26) as u8))
                .collect(),
        );
        SessionEnvelope {
            session: Session {
                source_id: format!("claude_code:{id}"),
                agent: AgentKind::ClaudeCode,
                agent_version: None,
                repo_remote: "github.com/acme/shop".into(),
                branch: None,
                cwd_relative: Some(String::new()),
                started_at: ts,
                ended_at: None,
                parent_source_id: None,
                permission_mode: None,
                instruction_files: None,
            },
            turns: vec![t],
        }
    }

    fn state(size: u64, id: &str) -> FileState {
        FileState {
            agent: "claude_code".into(),
            size,
            mtime_ns: Some(1),
            byte_offset: size,
            sent_while_active: false,
            sessions: vec![SessionProgress {
                source_id: format!("claude_code:{id}"),
                sent_turns: 1,
                resend_from: 0,
            }],
        }
    }

    fn put(db: &mut StateDb, id: &str, limit: u64) -> EnqueueReport {
        let path = PathBuf::from(format!("C:/x/{id}.jsonl"));
        enqueue_envelopes(
            db,
            vec![env(id, 4000)],
            &HashMap::from([(format!("claude_code:{id}"), "proj".to_owned())]),
            vec![Reservation {
                path,
                state: state(10, id),
                source_ids: vec![format!("claude_code:{id}")],
            }],
            1 << 20,
            limit,
        )
        .unwrap()
    }

    #[test]
    fn xep_hang_dat_cho_tien_do_chua_chot_offset() {
        let mut db = StateDb::open_in_memory().unwrap();
        let r = put(&mut db, "a", MAX_QUEUE_BYTES);
        assert_eq!((r.batches, r.turns, r.dropped), (1, 1, 0));
        let p = Path::new("C:/x/a.jsonl");
        assert_eq!(db.file(p).unwrap(), None, "chưa gửi thì chưa chốt");
        assert_eq!(db.effective_file(p).unwrap(), Some(state(10, "a")));
        let stats = queue_stats(&db).unwrap();
        assert_eq!(stats.pending_batches, 1);
        assert_eq!(stats.pending_bytes, r.bytes);

        // File không có gì để gửi (ngoài phạm vi): chốt ngay.
        let q = Path::new("C:/x/empty.jsonl");
        enqueue_envelopes(
            &mut db,
            Vec::new(),
            &HashMap::new(),
            vec![Reservation {
                path: q.into(),
                state: state(5, "x"),
                source_ids: Vec::new(),
            }],
            1 << 20,
            MAX_QUEUE_BYTES,
        )
        .unwrap();
        assert_eq!(db.file(q).unwrap(), Some(state(5, "x")));

        clear(&mut db).unwrap();
        assert_eq!(queue_stats(&db).unwrap().pending_batches, 0);
        assert_eq!(db.effective_file(p).unwrap(), None);
    }

    #[test]
    fn vuot_dung_luong_bo_batch_cu_nhat() {
        let mut db = StateDb::open_in_memory().unwrap();
        let one = put(&mut db, "a", MAX_QUEUE_BYTES).bytes;
        let first = list_pending(&db).unwrap()[0].batch_id.clone();
        // Giới hạn chứa vừa 2 batch.
        let limit = one * 2 + one / 2;
        assert_eq!(put(&mut db, "b", limit).dropped, 0);
        let r = put(&mut db, "c", limit);
        assert_eq!(r.dropped, 1);
        let pending = list_pending(&db).unwrap();
        assert_eq!(pending.len(), 2);
        assert!(
            pending.iter().all(|b| b.batch_id != first),
            "bỏ batch cũ nhất"
        );
        let stats = queue_stats(&db).unwrap();
        assert_eq!(stats.dropped_batches, 1);
        assert!(stats.pending_bytes <= limit);
        // Batch bị bỏ: tiến độ của nó coi như xong (không đọc lại rồi đầy lại mãi).
        assert_eq!(
            db.file(Path::new("C:/x/a.jsonl")).unwrap(),
            Some(state(10, "a"))
        );
        assert_eq!(db.file(Path::new("C:/x/b.jsonl")).unwrap(), None);
        put(&mut db, "d", limit);
        assert_eq!(queue_stats(&db).unwrap().dropped_batches, 2, "cộng dồn");
    }

    #[test]
    fn chia_doi_batch_413() {
        let batch = new_batch(vec![env("a", 10), env("b", 10), env("c", 10)]);
        let [x, y] = split(&gzip_json(&batch).unwrap()).unwrap();
        assert_eq!(x.sessions.len() + y.sessions.len(), 3);
        assert_ne!(x.batch_id, y.batch_id);
        let mut one = env("a", 10);
        one.turns.push(one.turns[0].clone());
        one.turns[1].seq = 1;
        let [x, y] = split(&gzip_json(&new_batch(vec![one])).unwrap()).unwrap();
        assert_eq!(
            (x.sessions[0].turns[0].seq, y.sessions[0].turns[0].seq),
            (0, 1)
        );
        assert!(split(&gzip_json(&new_batch(vec![env("a", 10)])).unwrap()).is_none());
    }
}
