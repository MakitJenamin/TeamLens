//! Dòng nhắc "có bản `tl` mới" ở cuối mọi lệnh (giống `gh`, `npm`).
//!
//! - Đọc kết quả kiểm đã lưu trong `state.db` (do daemon, `tl update` hoặc lần kiểm nhẹ trước
//!   ghi: [`auto::META_LATEST`], [`auto::META_LAST_CHECK`]) nên bình thường không gọi mạng.
//! - Kiểm nhẹ khi lần kiểm thành công gần nhất cũ hơn [`STALE_AFTER`] (hoặc chưa có) **và** lần
//!   thử gần nhất ([`auto::META_LAST_ATTEMPT`]) cách hơn [`RETRY_AFTER`] (máy mất mạng không thử
//!   ở mọi lệnh). Lần kiểm chạy trên thread riêng ngay khi lệnh bắt đầu, song song với lệnh; lệnh
//!   xong thì chờ thêm tối đa [`WAIT_AFTER_COMMAND`], HTTP client timeout cứng [`HTTP_TIMEOUT`].
//! - Mốc thử được ghi **trước** khi gọi mạng, để lệnh thoát giữa chừng (hết thời gian chờ) vẫn
//!   tính là đã thử. Thành công thì [`auto::record_check`]. Lỗi/timeout **không** ghi
//!   [`auto::META_LAST_ERROR`]: lỗi đó hiện trong `tl status` cho daemon và `tl update`, còn lần
//!   kiểm nhẹ timeout 3 giây hay lỗi vặt, ghi vào sẽ báo động giả.
//! - In ra **stderr** (stdout, `--json` giữ sạch), chỉ khi stderr là terminal. Không nhắc ở
//!   `update`, `daemon`, `uninstall`, `status` (đã có dòng "Phiên bản"). Tắt bằng
//!   `TL_NO_UPDATE_NOTIFIER=1`, hoặc khi biến `CI` được đặt.
//! - Mọi lỗi (mở `state.db`, mạng, parse) đều bị nuốt: không đổi kết quả hay mã thoát của lệnh.
//! - Tôn trọng `TL_UPDATE_BASE_URL`/`TL_UPDATE_VERSION`/`TL_UPDATE_API_URL` như `tl update`.

use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use chrono::{DateTime, Utc};

use super::{auto, UpdateSource, Updater, Version};
use crate::cli::Command;
use crate::context::AppContext;
use crate::state::{state_path, StateDb};

/// Kết quả kiểm cũ hơn mốc này thì kiểm nhẹ lại.
pub const STALE_AFTER: Duration = auto::CHECK_INTERVAL;
/// Khoảng cách tối thiểu giữa hai lần thử (thành công hay lỗi).
pub const RETRY_AFTER: Duration = Duration::from_secs(60 * 60);
/// Lệnh xong rồi chờ lần kiểm nhẹ thêm tối đa chừng này.
pub const WAIT_AFTER_COMMAND: Duration = Duration::from_secs(2);
/// Timeout cứng của HTTP client cho lần kiểm nhẹ.
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(3);
/// Đặt (khác `0`/`false`) để tắt dòng nhắc.
pub const DISABLE_ENV: &str = "TL_NO_UPDATE_NOTIFIER";
/// Đang chạy trong CI: không nhắc.
pub const CI_ENV: &str = "CI";

/// Lệnh có được in dòng nhắc không.
pub fn command_wants_notice(command: &Command) -> bool {
    !matches!(
        command,
        Command::Update(_) | Command::Daemon(_) | Command::Uninstall(_) | Command::Status(_)
    )
}

fn truthy(value: Option<String>) -> bool {
    value
        .map(|v| v.trim().to_ascii_lowercase())
        .is_some_and(|v| !v.is_empty() && !["0", "false", "no", "off"].contains(&v.as_str()))
}

/// Dòng nhắc bị tắt bằng biến môi trường ([`DISABLE_ENV`], [`CI_ENV`]).
pub fn disabled_by_vars(get: impl Fn(&str) -> Option<String>) -> bool {
    truthy(get(DISABLE_ENV)) || truthy(get(CI_ENV))
}

/// Có cần kiểm nhẹ qua mạng không.
pub fn needs_check(
    last_check: Option<DateTime<Utc>>,
    last_attempt: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    let older_than = |t: Option<DateTime<Utc>>, d: Duration| match t {
        None => true,
        // Đồng hồ máy lùi (mốc ở tương lai): coi như vừa kiểm, không gọi mạng.
        Some(t) => (now - t).to_std().is_ok_and(|age| age >= d),
    };
    older_than(last_check, STALE_AFTER) && older_than(last_attempt, RETRY_AFTER)
}

/// Dòng nhắc khi `latest` mới hơn `current` theo semver, `None` nếu không có gì để nhắc.
pub fn notice_line(latest: &Version, current: &Version) -> Option<String> {
    (latest > current)
        .then(|| format!("Có bản tl {latest} (đang dùng {current}). Chạy `tl update`."))
}

/// Tham số của dòng nhắc, tách ra để test thay được.
#[derive(Debug, Clone)]
pub struct NoticeOptions {
    /// stderr là terminal (không nhắc khi bị chuyển hướng ra file/pipe).
    pub stderr_is_terminal: bool,
    /// Tắt bằng biến môi trường.
    pub disabled: bool,
    pub source: UpdateSource,
    /// Bản đang chạy.
    pub current: Version,
    pub wait_after_command: Duration,
    pub http_timeout: Duration,
}

impl NoticeOptions {
    /// Theo máy đang chạy.
    pub fn from_env() -> Self {
        Self {
            stderr_is_terminal: std::io::stderr().is_terminal(),
            disabled: disabled_by_vars(|k| std::env::var(k).ok()),
            source: UpdateSource::from_env(),
            current: super::current_version(),
            wait_after_command: WAIT_AFTER_COMMAND,
            http_timeout: HTTP_TIMEOUT,
        }
    }
}

/// `state.db` của máy đang chạy (theo `TL_DATA_DIR`), `None` nếu không xác định được.
pub fn default_state_path() -> Option<PathBuf> {
    AppContext::from_platform()
        .ok()
        .map(|ctx| state_path(&ctx.config_path))
}

/// Lần nhắc của một lệnh: [`Notifier::start`] khi lệnh bắt đầu, [`Notifier::finish`] khi xong.
pub struct Notifier {
    pending: Option<mpsc::Receiver<Option<Version>>>,
    current: Version,
    wait: Duration,
}

impl Notifier {
    /// Bắt đầu đọc `state.db` (và kiểm nhẹ nếu cần) trên thread riêng. Lệnh không cần nhắc,
    /// stderr không phải terminal hoặc bị tắt thì không làm gì (không mở `state.db`, không gọi
    /// mạng).
    pub fn start(
        command: &Command,
        state_db: impl FnOnce() -> Option<PathBuf>,
        opts: NoticeOptions,
    ) -> Self {
        let mut notifier = Self {
            pending: None,
            current: opts.current.clone(),
            wait: opts.wait_after_command,
        };
        if !opts.stderr_is_terminal || opts.disabled || !command_wants_notice(command) {
            return notifier;
        }
        let Some(path) = state_db() else {
            return notifier;
        };
        let (tx, rx) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("tl-update-notice".into())
            .spawn(move || {
                let latest = lookup(&path, opts.source, opts.http_timeout);
                let _ = tx.send(latest);
            });
        if spawned.is_ok() {
            notifier.pending = Some(rx);
        }
        notifier
    }

    /// Chờ kết quả (tối đa `wait_after_command`) rồi in dòng nhắc ra `err` nếu có bản mới.
    /// Trả `true` khi đã in. Hết giờ thì bỏ qua; thread kiểm dở chết theo tiến trình.
    pub fn finish(self, err: &mut dyn Write) -> bool {
        let Some(rx) = self.pending else {
            return false;
        };
        let Ok(Some(latest)) = rx.recv_timeout(self.wait) else {
            return false;
        };
        let Some(line) = notice_line(&latest, &self.current) else {
            return false;
        };
        writeln!(err).and_then(|_| writeln!(err, "{line}")).is_ok()
    }
}

fn parse_time(text: Option<String>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&text?)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// Bản mới nhất để so: đọc từ `state.db`, kiểm nhẹ qua mạng nếu kết quả lưu đã cũ. `None` khi
/// không biết (chưa từng kiểm, lỗi mở DB, kiểm nhẹ lỗi).
fn lookup(path: &std::path::Path, source: UpdateSource, timeout: Duration) -> Option<Version> {
    let db = StateDb::open(path).ok()?;
    let meta = |k: &str| db.meta(k).ok().flatten().filter(|v| !v.is_empty());
    let now = Utc::now();
    let last_check = parse_time(meta(auto::META_LAST_CHECK));
    let last_attempt = parse_time(meta(auto::META_LAST_ATTEMPT));
    if !needs_check(last_check, last_attempt, now) {
        return meta(auto::META_LATEST).and_then(|v| Version::parse(&v));
    }

    // Ghi mốc thử trước khi gọi mạng (xem tài liệu module).
    db.set_meta(auto::META_LAST_ATTEMPT, &now.to_rfc3339())
        .ok()?;
    let updater = Updater::with_timeout(source, timeout, timeout).ok()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    let release = runtime
        .block_on(async { tokio::time::timeout(timeout, updater.resolve()).await })
        .ok()?;
    match release {
        Ok(release) => {
            let _ = auto::record_check(&db, Utc::now(), &release.version);
            Some(release.version)
        }
        Err(e) => {
            tracing::debug!(error = %e, "kiểm nhẹ bản tl mới lỗi, bỏ qua");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Cli;
    use chrono::TimeZone;
    use clap::Parser;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    fn t(minutes: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 27, 0, 0, 0).unwrap() + chrono::Duration::minutes(minutes)
    }

    fn cmd(args: &[&str]) -> Command {
        let mut full = vec!["tl"];
        full.extend_from_slice(args);
        Cli::try_parse_from(full).unwrap().command
    }

    #[test]
    fn chi_nhac_khi_ban_luu_moi_hon() {
        let cur = v("0.2.0");
        assert_eq!(
            notice_line(&v("0.2.1"), &cur).as_deref(),
            Some("Có bản tl 0.2.1 (đang dùng 0.2.0). Chạy `tl update`.")
        );
        assert_eq!(notice_line(&v("0.2.0"), &cur), None, "bằng nhau");
        assert_eq!(notice_line(&v("0.1.9"), &cur), None, "bản lưu cũ hơn");
        assert_eq!(
            notice_line(&v("0.2.0-rc.1"), &cur),
            None,
            "prerelease cùng số nhỏ hơn bản chính thức"
        );
        assert!(notice_line(&v("0.2.1-rc.1"), &cur).is_some());
        assert!(notice_line(&v("0.2.1"), &v("0.2.1-rc.2")).is_some());
        assert_eq!(notice_line(&v("0.2.1-rc.1"), &v("0.2.1-rc.2")), None);
    }

    #[test]
    fn lenh_bi_loai_tru() {
        for args in [
            &["update"][..],
            &["update", "--check"],
            &["daemon"],
            &["uninstall"],
            &["status"],
            &["status", "--json"],
        ] {
            assert!(!command_wants_notice(&cmd(args)), "{args:?} không nhắc");
        }
        for args in [
            &["pause"][..],
            &["resume"],
            &["sync"],
            &["preview"],
            &["open"],
        ] {
            assert!(command_wants_notice(&cmd(args)), "{args:?} có nhắc");
        }
    }

    #[test]
    fn tat_bang_bien_moi_truong() {
        let off = |pairs: &[(&str, &str)]| {
            let pairs: Vec<(String, String)> = pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            disabled_by_vars(|k| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()))
        };
        assert!(!off(&[]));
        assert!(off(&[(DISABLE_ENV, "1")]));
        assert!(off(&[(DISABLE_ENV, "true")]));
        assert!(!off(&[(DISABLE_ENV, "0")]));
        assert!(!off(&[(DISABLE_ENV, " ")]));
        assert!(off(&[(CI_ENV, "true")]));
        assert!(off(&[(CI_ENV, "1")]));
        assert!(!off(&[(CI_ENV, "false")]));
    }

    #[test]
    fn quyet_dinh_kiem_mang() {
        let now = t(48 * 60);
        assert!(needs_check(None, None, now), "chưa kiểm lần nào");
        assert!(!needs_check(
            Some(now - chrono::Duration::hours(23)),
            None,
            now
        ));
        assert!(needs_check(
            Some(now - chrono::Duration::hours(24)),
            None,
            now
        ));
        let stale = Some(now - chrono::Duration::hours(30));
        assert!(
            !needs_check(stale, Some(now - chrono::Duration::minutes(59)), now),
            "vừa thử (lỗi) chưa tới 1 giờ"
        );
        assert!(needs_check(
            stale,
            Some(now - chrono::Duration::minutes(60)),
            now
        ));
        assert!(
            !needs_check(None, Some(now - chrono::Duration::minutes(5)), now),
            "chưa kiểm thành công lần nào nhưng vừa thử"
        );
        assert!(
            !needs_check(Some(now + chrono::Duration::hours(1)), None, now),
            "đồng hồ lùi"
        );
    }

    fn opts(terminal: bool, disabled: bool) -> NoticeOptions {
        NoticeOptions {
            stderr_is_terminal: terminal,
            disabled,
            source: UpdateSource {
                // Không bao giờ được gọi: các ca dưới không kiểm mạng.
                api_url: "http://127.0.0.1:9/khong-duoc-goi".into(),
                base_url: None,
                version: None,
            },
            current: v("0.2.0"),
            wait_after_command: Duration::from_secs(2),
            http_timeout: Duration::from_secs(3),
        }
    }

    #[test]
    fn khong_terminal_tat_hoac_lenh_loai_tru_thi_khong_mo_state_db() {
        let called = std::cell::Cell::new(0);
        let path = || {
            called.set(called.get() + 1);
            None
        };
        let mut err = Vec::new();
        assert!(!Notifier::start(&cmd(&["pause"]), path, opts(false, false)).finish(&mut err));
        assert!(!Notifier::start(&cmd(&["pause"]), path, opts(true, true)).finish(&mut err));
        assert!(!Notifier::start(&cmd(&["status"]), path, opts(true, false)).finish(&mut err));
        assert_eq!(called.get(), 0);
        assert!(err.is_empty());
    }

    #[test]
    fn doc_ket_qua_da_luu_khong_goi_mang() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        let db = StateDb::open(&path).unwrap();
        auto::record_check(&db, Utc::now(), &v("0.2.1")).unwrap();
        drop(db);
        let mut err = Vec::new();
        let n = Notifier::start(&cmd(&["pause"]), || Some(path.clone()), opts(true, false));
        assert!(n.finish(&mut err));
        assert_eq!(
            String::from_utf8(err).unwrap(),
            "\nCó bản tl 0.2.1 (đang dùng 0.2.0). Chạy `tl update`.\n"
        );
    }
}
