//! Lịch của daemon, thuần (chỉ so `Instant`), để test không phụ thuộc thời gian thật.
//!
//! - [`Debouncer`]: gom sự kiện file. Mỗi file chỉ được xét khi đã yên lặng
//!   [`STABLE_AFTER`] + [`SETTLE`] kể từ sự kiện cuối, lúc đó [`crate::sync::incremental::classify`]
//!   thấy file đã ổn định 2 phút.
//! - [`Schedule`]: quét lại toàn bộ mỗi [`RESCAN_INTERVAL`], tải lại config mỗi
//!   [`CONFIG_REFRESH_INTERVAL`] (lỗi thì thử lại sau [`CONNECT_RETRY_INTERVAL`]),
//!   heartbeat mỗi [`HEARTBEAT_INTERVAL`], và lần thử gửi lại do hàng đợi hẹn (backoff M3.1).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::pipeline::collect::STABLE_AFTER;

/// Quét lại toàn bộ thư mục log định kỳ để không sót sự kiện (SPEC 4.2).
pub const RESCAN_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// Tải lại `GET /agent/v1/config` (SPEC 6.1).
pub const CONFIG_REFRESH_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Chưa kết nối được server (mất mạng lúc khởi động, chưa có cache): thử lại sau chừng này.
pub const CONNECT_RETRY_INTERVAL: Duration = Duration::from_secs(60);
pub use crate::heartbeat::HEARTBEAT_INTERVAL;
/// Chờ thêm sau mốc ổn định để chắc chắn mtime đã quá 2 phút khi quét.
pub const SETTLE: Duration = Duration::from_secs(5);

/// Gom sự kiện theo file: nhớ thời điểm sự kiện cuối của từng file.
#[derive(Debug)]
pub struct Debouncer {
    quiet: Duration,
    pending: HashMap<PathBuf, Instant>,
}

impl Default for Debouncer {
    fn default() -> Self {
        Self::new(STABLE_AFTER + SETTLE)
    }
}

impl Debouncer {
    /// File được xét khi yên lặng `quiet` kể từ sự kiện cuối.
    pub fn new(quiet: Duration) -> Self {
        Self {
            quiet,
            pending: HashMap::new(),
        }
    }

    /// Ghi nhận một sự kiện của `path` lúc `at` (sự kiện mới đẩy mốc xét lùi lại).
    pub fn record(&mut self, path: PathBuf, at: Instant) {
        let slot = self.pending.entry(path).or_insert(at);
        if at > *slot {
            *slot = at;
        }
    }

    /// Thời điểm sớm nhất có file đủ yên lặng, `None` khi không có gì chờ.
    pub fn due_at(&self) -> Option<Instant> {
        self.pending.values().min().map(|t| *t + self.quiet)
    }

    /// Có file đủ yên lặng tại `now`?
    pub fn is_due(&self, now: Instant) -> bool {
        self.due_at().is_some_and(|t| t <= now)
    }

    /// Sau một lần quét lúc `now`: bỏ các file đã đủ yên lặng (lần quét đó đã xử lý),
    /// giữ file còn đang được ghi. Trả số file đã bỏ.
    pub fn take_due(&mut self, now: Instant) -> usize {
        let before = self.pending.len();
        let quiet = self.quiet;
        self.pending.retain(|_, t| *t + quiet > now);
        before - self.pending.len()
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

/// Các mốc hẹn của daemon.
#[derive(Debug, Clone)]
pub struct Schedule {
    next_scan: Instant,
    next_config: Instant,
    next_heartbeat: Instant,
    /// Hàng đợi hẹn thử gửi lại (backoff/`Retry-After`), sớm hơn lần quét kế tiếp.
    retry_at: Option<Instant>,
}

impl Schedule {
    /// Khởi động: tải config, heartbeat và quét ngay.
    pub fn new(now: Instant) -> Self {
        Self {
            next_scan: now,
            next_config: now,
            next_heartbeat: now,
            retry_at: None,
        }
    }

    /// Lần thức dậy kế tiếp (kể cả mốc của [`Debouncer`]).
    pub fn next_wake(&self, debounce_due: Option<Instant>) -> Instant {
        [
            Some(self.next_scan),
            Some(self.next_config),
            Some(self.next_heartbeat),
            self.retry_at,
            debounce_due,
        ]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(self.next_scan)
    }

    pub fn config_due(&self, now: Instant) -> bool {
        self.next_config <= now
    }

    /// Đã thử tải config: thành công → 1 giờ sau; lỗi → thử lại sớm.
    pub fn config_done(&mut self, now: Instant, ok: bool) {
        self.next_config = now
            + if ok {
                CONFIG_REFRESH_INTERVAL
            } else {
                CONNECT_RETRY_INTERVAL
            };
    }

    pub fn heartbeat_due(&self, now: Instant) -> bool {
        self.next_heartbeat <= now
    }

    pub fn heartbeat_done(&mut self, now: Instant) {
        self.next_heartbeat = now + HEARTBEAT_INTERVAL;
    }

    /// Tới lịch quét định kỳ hoặc lịch gửi lại của hàng đợi.
    pub fn scan_due(&self, now: Instant) -> bool {
        self.next_scan <= now || self.retry_at.is_some_and(|t| t <= now)
    }

    /// Quét ngay ở lần thức kế tiếp (vd. vừa kết nối lại được server).
    pub fn scan_now(&mut self, now: Instant) {
        self.next_scan = now;
    }

    /// Đã quét xong lúc `now`; `retry_after` = hàng đợi hẹn gửi lại sau chừng này.
    pub fn scan_done(&mut self, now: Instant, retry_after: Option<Duration>) {
        self.next_scan = now + RESCAN_INTERVAL;
        // Hẹn trễ hơn lần quét định kỳ thì để lần quét đó lo.
        self.retry_at = retry_after
            .filter(|d| *d < RESCAN_INTERVAL)
            .map(|d| now + d.max(Duration::from_secs(1)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn debounce_doi_file_yen_lang_du_lau() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(secs(125));
        assert!(d.due_at().is_none());
        assert!(!d.is_due(t0 + secs(3600)));

        let a = PathBuf::from("a.jsonl");
        d.record(a.clone(), t0);
        assert_eq!(d.due_at(), Some(t0 + secs(125)));
        // Nhiều sự kiện liên tiếp của cùng file: mốc lùi theo sự kiện cuối.
        d.record(a.clone(), t0 + secs(30));
        d.record(a.clone(), t0 + secs(10)); // sự kiện tới muộn, cũ hơn: không kéo mốc về trước
        assert_eq!(d.len(), 1);
        assert_eq!(d.due_at(), Some(t0 + secs(155)));
        assert!(!d.is_due(t0 + secs(154)));
        assert!(d.is_due(t0 + secs(155)));
    }

    #[test]
    fn debounce_chi_bo_file_da_xu_ly() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(secs(125));
        d.record(PathBuf::from("xong.jsonl"), t0);
        d.record(PathBuf::from("dang-ghi.jsonl"), t0 + secs(100));
        // Quét lúc t0+125: file đầu đủ yên lặng, file sau còn đang ghi.
        assert_eq!(d.take_due(t0 + secs(125)), 1);
        assert_eq!(d.len(), 1);
        assert_eq!(d.due_at(), Some(t0 + secs(225)));
        assert_eq!(d.take_due(t0 + secs(225)), 1);
        assert!(d.is_empty());
    }

    #[test]
    fn debounce_mac_dinh_la_on_dinh_cong_settle() {
        let t0 = Instant::now();
        let mut d = Debouncer::default();
        d.record(PathBuf::from("a.jsonl"), t0);
        assert_eq!(d.due_at(), Some(t0 + STABLE_AFTER + SETTLE));
    }

    #[test]
    fn lich_khoi_dong_lam_moi_thu_ngay() {
        let t0 = Instant::now();
        let s = Schedule::new(t0);
        assert!(s.scan_due(t0));
        assert!(s.config_due(t0));
        assert!(s.heartbeat_due(t0));
        assert_eq!(s.next_wake(None), t0);
    }

    #[test]
    fn lich_quet_lai_10_phut_config_1_gio_heartbeat_15_phut() {
        let t0 = Instant::now();
        let mut s = Schedule::new(t0);
        s.config_done(t0, true);
        s.heartbeat_done(t0);
        s.scan_done(t0, None);
        assert_eq!(RESCAN_INTERVAL, secs(600));
        assert!(!s.scan_due(t0 + secs(599)));
        assert!(s.scan_due(t0 + secs(600)));
        assert_eq!(s.next_wake(None), t0 + secs(600));
        assert!(!s.config_due(t0 + secs(3599)));
        assert!(s.config_due(t0 + secs(3600)));
        assert!(!s.heartbeat_due(t0 + secs(899)));
        assert!(s.heartbeat_due(t0 + secs(900)));
        // Sự kiện file chờ ổn định sớm hơn lần quét định kỳ.
        assert_eq!(s.next_wake(Some(t0 + secs(130))), t0 + secs(130));
    }

    #[test]
    fn lich_config_loi_thu_lai_som() {
        let t0 = Instant::now();
        let mut s = Schedule::new(t0);
        s.config_done(t0, false);
        assert!(!s.config_due(t0 + secs(59)));
        assert!(s.config_due(t0 + CONNECT_RETRY_INTERVAL));
    }

    #[test]
    fn lich_gui_lai_theo_hang_doi() {
        let t0 = Instant::now();
        let mut s = Schedule::new(t0);
        s.config_done(t0, true);
        s.heartbeat_done(t0);
        // Hàng đợi hẹn thử lại sau 30 giây (backoff M3.1).
        s.scan_done(t0, Some(secs(30)));
        assert_eq!(s.next_wake(None), t0 + secs(30));
        assert!(s.scan_due(t0 + secs(30)));
        // Quét lại xong, không còn hẹn: về lịch 10 phút.
        s.scan_done(t0 + secs(30), None);
        assert!(!s.scan_due(t0 + secs(60)));
        // Hẹn xa hơn lần quét định kỳ thì bỏ (lần quét định kỳ lo).
        s.scan_done(t0, Some(secs(30 * 60)));
        assert_eq!(s.next_wake(None), t0 + RESCAN_INTERVAL);
        // Hẹn 0 giây: vẫn chờ tối thiểu 1 giây, không quay vòng liên tục.
        s.scan_done(t0, Some(Duration::ZERO));
        assert_eq!(s.next_wake(None), t0 + secs(1));
    }
}
