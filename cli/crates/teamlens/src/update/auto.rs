//! Tự cập nhật trong daemon (M5.3) và trạng thái kiểm tra bản mới lưu trong `state.db`.
//!
//! - Kiểm định kỳ mỗi [`CHECK_INTERVAL`] (24 giờ). Mốc kiểm kế tiếp lưu trong bảng `meta`
//!   ([`META_NEXT_ATTEMPT`]) nên daemon khởi động lại (đăng nhập Windows) không kiểm lại ngay.
//! - Server báo cần bản mới (`426` hoặc `min_cli_version` cao hơn): kiểm sớm, nhưng không sớm
//!   hơn [`UPGRADE_RECHECK`] kể từ lần thử trước (tránh gọi GitHub mỗi chu kỳ khi server đòi
//!   bản chưa phát hành).
//! - Lỗi mạng, SHA-256 sai, bản tải về hỏng: ghi log, giữ bản cũ, thử lại sau [`backoff`]
//!   (15 phút, gấp đôi mỗi lần, tối đa 24 giờ). Không bao giờ làm dừng vòng lặp daemon.
//! - **Vẫn cập nhật khi đang `tl pause`**: cập nhật chỉ tải file từ GitHub, không gửi dữ liệu
//!   nào của máy; để bản cũ thì lúc `tl resume` có thể bị server từ chối.
//! - Tắt bằng `TL_AUTO_UPDATE=0`. Bản build debug (`cargo run`) mặc định không tự cập nhật để
//!   không ghi đè file trong `target/`; đặt `TL_AUTO_UPDATE=1` để bật.

use std::path::Path;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;

use super::{Updater, Version};
use crate::state::StateDb;

/// Kiểm bản mới định kỳ.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// Khi server đòi bản mới: khoảng cách tối thiểu giữa hai lần thử.
pub const UPGRADE_RECHECK: Duration = Duration::from_secs(60 * 60);
/// Backoff sau lần lỗi đầu tiên.
pub const FIRST_BACKOFF: Duration = Duration::from_secs(15 * 60);
/// Bật/tắt tự cập nhật trong daemon.
pub const AUTO_ENV: &str = "TL_AUTO_UPDATE";

/// Khóa `meta`: lần kiểm thành công gần nhất (RFC 3339).
pub const META_LAST_CHECK: &str = "update_last_check_at";
/// Khóa `meta`: bản phát hành mới nhất thấy ở lần kiểm thành công gần nhất.
pub const META_LATEST: &str = "update_latest_version";
/// Khóa `meta`: lỗi của lần thử gần nhất (rỗng khi thành công).
pub const META_LAST_ERROR: &str = "update_last_error";
/// Khóa `meta`: lần thử gần nhất (thành công hay lỗi).
pub const META_LAST_ATTEMPT: &str = "update_last_attempt_at";
/// Khóa `meta`: daemon hẹn kiểm lần tới.
pub const META_NEXT_ATTEMPT: &str = "update_next_attempt_at";
/// Khóa `meta`: số lần lỗi liên tiếp (tính backoff).
pub const META_FAILURES: &str = "update_failures";

/// Thông tin kiểm bản mới, cho `tl status`.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Bản phát hành mới nhất đã thấy, `null` nếu chưa kiểm lần nào.
    pub latest_version: Option<String>,
    /// Lúc kiểm thành công gần nhất.
    pub checked_at: Option<DateTime<Utc>>,
    /// `latest_version` mới hơn bản đang chạy.
    pub update_available: bool,
    /// Lỗi của lần kiểm/cập nhật gần nhất.
    pub last_error: Option<String>,
}

fn parse_time(text: Option<String>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&text?)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// Đọc trạng thái kiểm bản mới từ `state.db`.
pub fn read_info(db: &StateDb) -> UpdateInfo {
    let latest = db
        .meta(META_LATEST)
        .ok()
        .flatten()
        .filter(|v| !v.is_empty());
    let update_available = latest
        .as_deref()
        .and_then(Version::parse)
        .is_some_and(|v| v > super::current_version());
    UpdateInfo {
        latest_version: latest,
        checked_at: parse_time(db.meta(META_LAST_CHECK).ok().flatten()),
        update_available,
        last_error: db
            .meta(META_LAST_ERROR)
            .ok()
            .flatten()
            .filter(|v| !v.is_empty()),
    }
}

/// Ghi một lần kiểm thành công (bản mới nhất là `latest`).
pub fn record_check(db: &StateDb, now: DateTime<Utc>, latest: &Version) -> rusqlite::Result<()> {
    let stamp = now.to_rfc3339();
    db.set_meta(META_LAST_CHECK, &stamp)?;
    db.set_meta(META_LAST_ATTEMPT, &stamp)?;
    db.set_meta(META_LATEST, &latest.to_string())?;
    db.set_meta(META_LAST_ERROR, "")?;
    db.set_meta(META_FAILURES, "0")
}

/// Ghi một lần thử lỗi.
pub fn record_failure(db: &StateDb, now: DateTime<Utc>, error: &str) -> rusqlite::Result<()> {
    db.set_meta(META_LAST_ATTEMPT, &now.to_rfc3339())?;
    db.set_meta(META_LAST_ERROR, error)
}

/// Backoff sau `failures` lần lỗi liên tiếp: 15 phút, 30 phút, 1 giờ... tối đa 24 giờ.
pub fn backoff(failures: u32) -> Duration {
    let exp = failures.saturating_sub(1).min(16);
    FIRST_BACKOFF
        .saturating_mul(1u32 << exp)
        .min(CHECK_INTERVAL)
}

/// Tự cập nhật có bật không, theo giá trị của [`AUTO_ENV`].
pub fn enabled_from(value: Option<&str>) -> bool {
    match value.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if ["0", "false", "off", "no"].contains(&v.as_str()) => false,
        Some(v) if ["1", "true", "on", "yes"].contains(&v.as_str()) => true,
        _ => !cfg!(debug_assertions),
    }
}

/// Kết quả một lần daemon thử tự cập nhật.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoOutcome {
    /// Đã là bản mới nhất.
    UpToDate(Version),
    /// Lỗi (đã ghi log, giữ bản cũ, hẹn thử lại).
    Failed(String),
    /// Đã thay file thực thi bằng bản này: daemon cần khởi động lại.
    Replaced(Version),
}

/// Lịch tự cập nhật của daemon (thuần theo `now` truyền vào, để test).
#[derive(Debug, Clone)]
pub struct AutoSchedule {
    pub enabled: bool,
    pub next_at: DateTime<Utc>,
    pub last_attempt_at: Option<DateTime<Utc>>,
    pub failures: u32,
}

impl AutoSchedule {
    /// Đọc lịch từ `state.db`; chưa có thì kiểm ngay.
    pub fn load(db: Option<&StateDb>, enabled: bool, now: DateTime<Utc>) -> Self {
        let meta = |k: &str| db.and_then(|db| db.meta(k).ok().flatten());
        Self {
            enabled,
            next_at: parse_time(meta(META_NEXT_ATTEMPT)).unwrap_or(now),
            last_attempt_at: parse_time(meta(META_LAST_ATTEMPT)),
            failures: meta(META_FAILURES)
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
        }
    }

    /// Mốc thức dậy kế tiếp, `None` khi tắt.
    pub fn wake_at(&self) -> Option<DateTime<Utc>> {
        self.enabled.then_some(self.next_at)
    }

    pub fn due(&self, now: DateTime<Utc>) -> bool {
        self.enabled && self.next_at <= now
    }

    /// Server báo `tl` quá cũ: kiểm sớm (nhưng cách lần thử trước ít nhất [`UPGRADE_RECHECK`]).
    pub fn upgrade_required(&mut self, now: DateTime<Utc>) {
        let earliest = match self.last_attempt_at {
            Some(t) => (t + UPGRADE_RECHECK).max(now),
            None => now,
        };
        if earliest < self.next_at {
            self.next_at = earliest;
        }
    }

    /// Đã thử lúc `now`: thành công → 24 giờ nữa; lỗi → backoff.
    pub fn done(&mut self, now: DateTime<Utc>, ok: bool) {
        self.last_attempt_at = Some(now);
        if ok {
            self.failures = 0;
            self.next_at = now + CHECK_INTERVAL;
        } else {
            self.failures = self.failures.saturating_add(1);
            self.next_at = now + backoff(self.failures);
        }
    }

    fn save(&self, db: &StateDb) -> rusqlite::Result<()> {
        db.set_meta(META_NEXT_ATTEMPT, &self.next_at.to_rfc3339())?;
        db.set_meta(META_FAILURES, &self.failures.to_string())
    }
}

/// Một lần daemon tự kiểm và (nếu có bản mới) cập nhật. Không bao giờ panic hay trả lỗi:
/// mọi lỗi được ghi log và vào `state.db`, lịch được hẹn lại.
pub async fn run_once(
    updater: &Updater,
    sched: &mut AutoSchedule,
    state_db: &Path,
    data_dir: &Path,
    now: DateTime<Utc>,
) -> AutoOutcome {
    let result = async {
        let check = updater.check().await?;
        if let Ok(db) = StateDb::open(state_db) {
            let _ = record_check(&db, now, &check.latest.version);
        }
        if !check.newer() {
            return Ok(AutoOutcome::UpToDate(check.latest.version));
        }
        tracing::info!(
            current = %check.current,
            latest = %check.latest.version,
            "có bản tl mới, đang tự cập nhật"
        );
        super::download_and_install(updater, &check.latest, data_dir).await?;
        Ok::<_, super::UpdateError>(AutoOutcome::Replaced(check.latest.version))
    }
    .await;
    let outcome = match result {
        Ok(o) => o,
        Err(e) => AutoOutcome::Failed(e.to_string()),
    };
    sched.done(now, !matches!(outcome, AutoOutcome::Failed(_)));
    if let Ok(db) = StateDb::open(state_db) {
        if let AutoOutcome::Failed(msg) = &outcome {
            let _ = record_failure(&db, now, msg);
        }
        if let Err(e) = sched.save(&db) {
            tracing::warn!(error = %e, "không ghi được lịch tự cập nhật vào state.db");
        }
    }
    match &outcome {
        AutoOutcome::UpToDate(v) => tracing::info!(latest = %v, "tl đã là bản mới nhất"),
        AutoOutcome::Failed(msg) => tracing::warn!(
            retry_at = %sched.next_at,
            "tự cập nhật lỗi, giữ bản đang chạy: {msg}"
        ),
        AutoOutcome::Replaced(v) => {
            tracing::info!(version = %v, "đã cập nhật tl, khởi động lại daemon")
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t(h: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 27, 0, 0, 0).unwrap() + chrono::Duration::hours(h)
    }

    #[test]
    fn backoff_gap_doi_toi_da_24h() {
        assert_eq!(backoff(1), Duration::from_secs(15 * 60));
        assert_eq!(backoff(2), Duration::from_secs(30 * 60));
        assert_eq!(backoff(3), Duration::from_secs(60 * 60));
        assert_eq!(backoff(10), CHECK_INTERVAL);
        assert_eq!(backoff(u32::MAX), CHECK_INTERVAL);
    }

    #[test]
    fn bat_tat_theo_bien_moi_truong() {
        assert!(!enabled_from(Some("0")));
        assert!(!enabled_from(Some(" Off ")));
        assert!(enabled_from(Some("1")));
        assert!(enabled_from(Some("true")));
        assert_eq!(enabled_from(None), !cfg!(debug_assertions));
    }

    #[test]
    fn lich_kiem_24h_va_backoff() {
        let mut s = AutoSchedule::load(None, true, t(0));
        assert!(s.due(t(0)), "chưa kiểm lần nào: kiểm ngay");
        s.done(t(0), true);
        assert!(!s.due(t(23)));
        assert!(s.due(t(24)));
        s.done(t(24), false);
        assert_eq!(s.failures, 1);
        assert_eq!(s.next_at, t(24) + chrono::Duration::minutes(15));
        s.done(s.next_at, false);
        assert_eq!(s.failures, 2);
        s.done(t(30), true);
        assert_eq!(s.failures, 0);
        assert_eq!(s.next_at, t(54));

        let off = AutoSchedule::load(None, false, t(0));
        assert!(!off.due(t(100)));
        assert_eq!(off.wake_at(), None);
    }

    #[test]
    fn server_doi_ban_moi_thi_kiem_som_nhung_khong_don_dap() {
        let mut s = AutoSchedule::load(None, true, t(0));
        s.done(t(0), true); // hẹn t(24)
        s.upgrade_required(t(0));
        assert_eq!(s.next_at, t(1), "cách lần thử trước ít nhất 1 giờ");
        s.upgrade_required(t(5));
        assert_eq!(s.next_at, t(1), "không lùi mốc đã sớm hơn");
        s.done(t(5), true); // vẫn chưa có bản mới
        s.upgrade_required(t(5));
        assert_eq!(s.next_at, t(6));
    }

    #[test]
    fn luu_va_doc_lai_tu_state_db() {
        let db = StateDb::open_in_memory().unwrap();
        assert_eq!(read_info(&db), UpdateInfo::default());
        let mut s = AutoSchedule::load(Some(&db), true, t(0));
        s.done(t(0), false);
        s.save(&db).unwrap();
        record_failure(&db, t(0), "Không kết nối được tới GitHub API: timeout").unwrap();
        let back = AutoSchedule::load(Some(&db), true, t(0));
        assert_eq!(back.failures, 1);
        assert_eq!(back.next_at, s.next_at);
        assert_eq!(back.last_attempt_at, Some(t(0)));
        let info = read_info(&db);
        assert!(info.last_error.unwrap().contains("GitHub API"));
        assert_eq!(info.checked_at, None);

        record_check(&db, t(1), &Version::parse("999.0.0").unwrap()).unwrap();
        let info = read_info(&db);
        assert_eq!(info.latest_version.as_deref(), Some("999.0.0"));
        assert!(info.update_available);
        assert_eq!(info.checked_at, Some(t(1)));
        assert_eq!(info.last_error, None, "kiểm thành công thì xóa lỗi cũ");
        record_check(&db, t(2), &super::super::current_version()).unwrap();
        assert!(!read_info(&db).update_available);
    }
}
