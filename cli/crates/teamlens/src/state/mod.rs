//! Trạng thái cục bộ trong SQLite `state.db` (cạnh `config.toml`, tức
//! `%LOCALAPPDATA%\teamlens\state.db` hoặc `TL_DATA_DIR\state.db`). Task M2.3.
//!
//! Chỉ lưu **metadata** để đọc tăng dần, không lưu nội dung session:
//!
//! - `source_files`: mỗi file log một dòng: agent, kích thước, mtime, offset byte đã đọc,
//!   có gửi lúc file còn đang được ghi hay không, thời điểm đổi cuối.
//! - `source_sessions`: tiến độ từng session trong file (`source_id`, số turn đã gửi
//!   thành công, `seq` phải gửi lại từ đó ở lần sau).
//! - `parse_errors`: file đọc lỗi hoặc có bản ghi không nhận ra (chỉ số đếm).
//! - `meta`: khóa/giá trị (dấu vân tay phạm vi gửi: server + repo pattern + đồng ý; cờ tạm dừng
//!   `tl pause`, heartbeat gần nhất, phiên bản agent đọc được — M3.3).
//!
//!
//! Migration v2 (M3.1) thêm hàng đợi batch (xem [`crate::queue`]):
//!
//! - `queue_batches`: batch **đã che** (gzip JSON) chờ gửi hoặc đã hỏng.
//! - `queue_reservations`: tiến độ file "đặt chỗ" lúc xếp hàng, chỉ chép sang
//!   `source_files`/`source_sessions` khi mọi batch liên quan đã xong.
//! - `queue_reservation_batches`: batch nào thuộc lần đặt chỗ nào.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// Tên file trạng thái, nằm cùng thư mục với `config.toml`.
pub const STATE_FILE: &str = "state.db";

/// Các bước migration theo `PRAGMA user_version`: phần tử thứ `i` đưa DB từ phiên bản
/// `i` lên `i + 1`. Chỉ thêm vào cuối, không sửa bước đã phát hành.
const MIGRATIONS: &[&str] = &[
    // v1 (M2.3): offset theo file + tiến độ session + lỗi parse.
    r#"
    CREATE TABLE source_files (
        path              TEXT PRIMARY KEY,
        agent             TEXT NOT NULL,
        size              INTEGER NOT NULL,
        mtime_ns          INTEGER,
        byte_offset       INTEGER NOT NULL,
        sent_while_active INTEGER NOT NULL DEFAULT 0,
        updated_at        TEXT NOT NULL
    );
    CREATE TABLE source_sessions (
        path        TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        source_id   TEXT NOT NULL,
        sent_turns  INTEGER NOT NULL,
        resend_from INTEGER NOT NULL,
        PRIMARY KEY (path, source_id)
    );
    CREATE TABLE parse_errors (
        path        TEXT PRIMARY KEY,
        agent       TEXT NOT NULL,
        warnings    INTEGER NOT NULL,
        read_failed INTEGER NOT NULL,
        updated_at  TEXT NOT NULL
    );
    CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // v2 (M3.1): hàng đợi batch đã che + tiến độ đặt chỗ chờ server nhận.
    r#"
    CREATE TABLE queue_batches (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id        TEXT NOT NULL UNIQUE,
        ord             INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        body            BLOB NOT NULL,
        size_bytes      INTEGER NOT NULL,
        turns           INTEGER NOT NULL,
        projects        TEXT NOT NULL DEFAULT '{}',
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_ms INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        created_at      TEXT NOT NULL
    );
    CREATE INDEX queue_batches_order ON queue_batches(status, ord, id);
    CREATE TABLE queue_reservations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        path       TEXT NOT NULL,
        state      TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX queue_reservations_path ON queue_reservations(path, id);
    CREATE TABLE queue_reservation_batches (
        reservation_id INTEGER NOT NULL REFERENCES queue_reservations(id) ON DELETE CASCADE,
        batch_id       TEXT NOT NULL,
        PRIMARY KEY (reservation_id, batch_id)
    );
    CREATE INDEX queue_reservation_batches_batch ON queue_reservation_batches(batch_id);
    "#,
];

/// Tiến độ gửi một session trong một file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionProgress {
    pub source_id: String,
    /// Số turn (tức `seq` lớn nhất + 1) server đã nhận.
    pub sent_turns: u32,
    /// Lần sau gửi lại từ `seq` này (turn có thể còn đổi: turn cuối, tool_call chưa có
    /// kết quả, assistant cuối có thể bị đánh dấu `interrupted`).
    pub resend_from: u32,
}

/// Trạng thái đã ghi của một file log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileState {
    pub agent: String,
    pub size: u64,
    /// mtime tính bằng nano giây từ epoch; `None` khi hệ điều hành không cho biết.
    pub mtime_ns: Option<i64>,
    /// Đã đọc (và gửi xong) tới byte này.
    pub byte_offset: u64,
    /// Lần gửi cuối diễn ra khi file còn đang được ghi (`ended_at` còn trống), nên khi
    /// file ổn định phải gửi lại metadata dù file không đổi.
    pub sent_while_active: bool,
    pub sessions: Vec<SessionProgress>,
}

impl FileState {
    pub fn session(&self, source_id: &str) -> Option<&SessionProgress> {
        self.sessions.iter().find(|s| s.source_id == source_id)
    }
}

/// Đổi `SystemTime` thành nano giây từ epoch (lưu vào SQLite).
pub fn mtime_ns(t: Option<SystemTime>) -> Option<i64> {
    let d = t?.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(d.as_nanos()).ok()
}

/// Khóa `meta`: cờ tạm dừng của `tl pause` (`"1"` khi đang tạm dừng).
pub const PAUSED_META_KEY: &str = "paused";

/// Khóa `meta`: danh sách [`PauseWindow`] (JSON).
pub const PAUSE_WINDOWS_META_KEY: &str = "pause_windows";

/// Một khoảng `tl pause` → `tl resume`: `[start, end)`, `end = None` khi còn đang tạm dừng.
/// Chỉ lưu thời điểm, không lưu nội dung.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PauseWindow {
    pub start: DateTime<Utc>,
    pub end: Option<DateTime<Utc>>,
}

impl PauseWindow {
    pub fn contains(&self, t: DateTime<Utc>) -> bool {
        t >= self.start && self.end.is_none_or(|end| t < end)
    }
}

/// Kết nối tới `state.db`.
pub struct StateDb {
    /// Module [`crate::queue`] dùng chung kết nối (bảng `queue_*`).
    pub(crate) conn: Connection,
}

/// Đường dẫn `state.db` cạnh file config.
pub fn state_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .map_or_else(|| PathBuf::from(STATE_FILE), |d| d.join(STATE_FILE))
}

fn db_error(path: &Path, e: impl std::fmt::Display) -> AppError {
    tracing::debug!(error = %e, path = %path.display(), "lỗi state.db");
    AppError::user(
        format!("Không mở/ghi được file trạng thái {}.", path.display()),
        "Kiểm tra quyền ghi thư mục dữ liệu TeamLens; nếu file hỏng có thể xóa state.db (lần sau sẽ gửi lại từ đầu, server không ghi trùng).",
    )
}

impl StateDb {
    /// Mở (tạo nếu chưa có) và chạy migration.
    pub fn open(path: &Path) -> Result<Self, AppError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| db_error(path, e))?;
        }
        let conn = Connection::open(path).map_err(|e| db_error(path, e))?;
        Self::init(conn).map_err(|e| db_error(path, e))
    }

    /// DB trong RAM (test).
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        let mut db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&mut self) -> rusqlite::Result<()> {
        let version: i64 = self
            .conn
            .pragma_query_value(None, "user_version", |r| r.get(0))?;
        let start = usize::try_from(version).unwrap_or(0);
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(start) {
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            tx.commit()?;
        }
        Ok(())
    }

    /// Phiên bản schema hiện tại.
    pub fn schema_version(&self) -> rusqlite::Result<i64> {
        self.conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
    }

    /// Trạng thái đã ghi của file, `None` nếu chưa từng gửi.
    pub fn file(&self, path: &Path) -> rusqlite::Result<Option<FileState>> {
        let key = path_key(path);
        let row = self
            .conn
            .query_row(
                "SELECT agent, size, mtime_ns, byte_offset, sent_while_active
                 FROM source_files WHERE path = ?1",
                [&key],
                |r| {
                    Ok(FileState {
                        agent: r.get(0)?,
                        size: r.get::<_, i64>(1)? as u64,
                        mtime_ns: r.get(2)?,
                        byte_offset: r.get::<_, i64>(3)? as u64,
                        sent_while_active: r.get(4)?,
                        sessions: Vec::new(),
                    })
                },
            )
            .optional()?;
        let Some(mut state) = row else {
            return Ok(None);
        };
        let mut stmt = self.conn.prepare(
            "SELECT source_id, sent_turns, resend_from FROM source_sessions
             WHERE path = ?1 ORDER BY source_id",
        )?;
        state.sessions = stmt
            .query_map([&key], |r| {
                Ok(SessionProgress {
                    source_id: r.get(0)?,
                    sent_turns: r.get(1)?,
                    resend_from: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Some(state))
    }

    /// Trạng thái để quét lần này: bản "đặt chỗ" mới nhất trong hàng đợi (batch đã xếp
    /// hàng nhưng server chưa nhận) nếu có, không thì bản đã chốt. Nhờ vậy mất mạng nhiều
    /// lần quét liền cũng không xếp hàng lại cùng nội dung.
    pub fn effective_file(&self, path: &Path) -> rusqlite::Result<Option<FileState>> {
        let reserved: Option<String> = self
            .conn
            .query_row(
                "SELECT state FROM queue_reservations WHERE path = ?1 ORDER BY id DESC LIMIT 1",
                [path_key(path)],
                |r| r.get(0),
            )
            .optional()?;
        match reserved {
            Some(json) => serde_json::from_str(&json)
                .map(Some)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e))),
            None => self.file(path),
        }
    }

    /// Ghi trạng thái file (thay toàn bộ tiến độ session của file) trong một transaction.
    pub fn save_file(&mut self, path: &Path, state: &FileState) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        save_file_tx(&tx, path, state)?;
        tx.commit()
    }

    /// Ghi (hoặc xóa khi không còn lỗi) thống kê lỗi parse của file.
    pub fn record_parse_errors(
        &self,
        path: &Path,
        agent: &str,
        warnings: u64,
        read_failed: bool,
    ) -> rusqlite::Result<()> {
        let key = path_key(path);
        if warnings == 0 && !read_failed {
            self.conn
                .execute("DELETE FROM parse_errors WHERE path = ?1", [&key])?;
            return Ok(());
        }
        self.conn.execute(
            "INSERT INTO parse_errors (path, agent, warnings, read_failed, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET agent = excluded.agent,
                warnings = excluded.warnings, read_failed = excluded.read_failed,
                updated_at = excluded.updated_at",
            params![
                key,
                agent,
                i64::try_from(warnings).unwrap_or(i64::MAX),
                read_failed,
                now_text()
            ],
        )?;
        Ok(())
    }

    /// Số file đang có lỗi parse/đọc.
    pub fn parse_error_files(&self) -> rusqlite::Result<u64> {
        self.conn
            .query_row("SELECT count(*) FROM parse_errors", [], |r| {
                r.get::<_, i64>(0)
            })
            .map(|n| n as u64)
    }

    pub fn meta(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
    }

    pub fn set_meta(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    /// Tổng số lỗi parse để báo qua heartbeat: số bản ghi không nhận ra cộng số file đọc lỗi.
    pub fn parse_error_total(&self) -> rusqlite::Result<u64> {
        self.conn
            .query_row(
                "SELECT COALESCE(SUM(warnings), 0) + COALESCE(SUM(read_failed), 0) FROM parse_errors",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map(|n| n.max(0) as u64)
    }

    /// `tl pause` đang bật (khóa `meta.paused`).
    pub fn is_paused(&self) -> rusqlite::Result<bool> {
        Ok(self.meta(PAUSED_META_KEY)?.as_deref() == Some("1"))
    }

    /// Bật/tắt cờ tạm dừng, đồng thời mở/đóng một khoảng tạm dừng (lúc `now`). Turn có
    /// `ts` trong khoảng tạm dừng không bao giờ được gửi (xem [`PauseWindow`]).
    pub fn set_paused(&self, paused: bool, now: DateTime<Utc>) -> rusqlite::Result<()> {
        let was = self.is_paused()?;
        let mut windows = self.pause_windows()?;
        if paused && !was {
            windows.push(PauseWindow {
                start: now,
                end: None,
            });
        } else if !paused {
            for w in windows.iter_mut().filter(|w| w.end.is_none()) {
                w.end = Some(now.max(w.start));
            }
        }
        let text = serde_json::to_string(&windows).expect("PauseWindow luôn serialize được");
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [PAUSE_WINDOWS_META_KEY, &text],
        )?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [PAUSED_META_KEY, if paused { "1" } else { "0" }],
        )?;
        tx.commit()
    }

    /// Các khoảng tạm dừng đã ghi (cũ nhất trước). Giá trị hỏng coi như không có.
    pub fn pause_windows(&self) -> rusqlite::Result<Vec<PauseWindow>> {
        Ok(self
            .meta(PAUSE_WINDOWS_META_KEY)?
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default())
    }

    /// Quên mọi offset (lần sau đọc và gửi lại từ đầu mọi file), kể cả tiến độ đặt chỗ
    /// của hàng đợi (batch đã xếp hàng vẫn giữ, xem [`crate::queue::clear`]).
    pub fn reset_files(&mut self) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM queue_reservations", [])?;
        tx.execute("DELETE FROM source_sessions", [])?;
        tx.execute("DELETE FROM source_files", [])?;
        tx.commit()
    }
}

/// Ghi trạng thái file trong transaction có sẵn (dùng chung với [`crate::queue`]).
pub(crate) fn save_file_tx(
    tx: &rusqlite::Transaction<'_>,
    path: &Path,
    state: &FileState,
) -> rusqlite::Result<()> {
    let key = path_key(path);
    tx.execute(
        "INSERT INTO source_files
            (path, agent, size, mtime_ns, byte_offset, sent_while_active, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(path) DO UPDATE SET
            agent = excluded.agent, size = excluded.size, mtime_ns = excluded.mtime_ns,
            byte_offset = excluded.byte_offset,
            sent_while_active = excluded.sent_while_active,
            updated_at = excluded.updated_at",
        params![
            key,
            state.agent,
            state.size as i64,
            state.mtime_ns,
            state.byte_offset as i64,
            state.sent_while_active,
            now_text(),
        ],
    )?;
    tx.execute("DELETE FROM source_sessions WHERE path = ?1", [&key])?;
    {
        let mut ins = tx.prepare(
            "INSERT INTO source_sessions (path, source_id, sent_turns, resend_from)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        for s in &state.sessions {
            ins.execute(params![key, s.source_id, s.sent_turns, s.resend_from])?;
        }
    }
    Ok(())
}

pub(crate) fn path_key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn now_text() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> FileState {
        FileState {
            agent: "claude_code".into(),
            size: 100,
            mtime_ns: Some(42),
            byte_offset: 100,
            sent_while_active: false,
            sessions: vec![SessionProgress {
                source_id: "claude_code:a".into(),
                sent_turns: 5,
                resend_from: 3,
            }],
        }
    }

    #[test]
    fn migration_dat_user_version_va_chay_lai_an_toan() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/state.db");
        let db = StateDb::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), MIGRATIONS.len() as i64);
        drop(db);
        let db = StateDb::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), MIGRATIONS.len() as i64);
    }

    #[test]
    fn luu_va_doc_lai_trang_thai_file() {
        let mut db = StateDb::open_in_memory().unwrap();
        let p = Path::new("C:/x/a.jsonl");
        assert_eq!(db.file(p).unwrap(), None);
        db.save_file(p, &sample()).unwrap();
        assert_eq!(db.file(p).unwrap(), Some(sample()));

        let mut next = sample();
        next.size = 200;
        next.sessions[0].sent_turns = 9;
        next.sessions.push(SessionProgress {
            source_id: "claude_code:b".into(),
            sent_turns: 1,
            resend_from: 0,
        });
        db.save_file(p, &next).unwrap();
        assert_eq!(db.file(p).unwrap(), Some(next));

        db.reset_files().unwrap();
        assert_eq!(db.file(p).unwrap(), None);
    }

    #[test]
    fn loi_parse_va_meta() {
        let db = StateDb::open_in_memory().unwrap();
        let p = Path::new("a.jsonl");
        db.record_parse_errors(p, "claude_code", 3, false).unwrap();
        assert_eq!(db.parse_error_files().unwrap(), 1);
        db.record_parse_errors(p, "claude_code", 0, false).unwrap();
        assert_eq!(db.parse_error_files().unwrap(), 0);

        db.record_parse_errors(p, "claude_code", 3, false).unwrap();
        db.record_parse_errors(Path::new("b.jsonl"), "codex", 0, true)
            .unwrap();
        assert_eq!(db.parse_error_total().unwrap(), 4);

        assert_eq!(db.meta("k").unwrap(), None);
        db.set_meta("k", "v1").unwrap();
        db.set_meta("k", "v2").unwrap();
        assert_eq!(db.meta("k").unwrap().as_deref(), Some("v2"));
    }

    #[test]
    fn migrate_v1_len_v2_giu_du_lieu() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        // DB do bản M2.3 tạo: chỉ có bước v1.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute(
                "INSERT INTO source_files (path, agent, size, mtime_ns, byte_offset, updated_at)
                 VALUES ('C:/x/a.jsonl', 'claude_code', 100, 42, 100, 'x')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO source_sessions VALUES ('C:/x/a.jsonl', 'claude_code:a', 5, 3)",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO meta VALUES ('k', 'v')", [])
                .unwrap();
        }
        let db = StateDb::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), 2);
        assert_eq!(db.file(Path::new("C:/x/a.jsonl")).unwrap(), Some(sample()));
        assert_eq!(db.meta("k").unwrap().as_deref(), Some("v"));
        let n: i64 = db
            .conn
            .query_row("SELECT count(*) FROM queue_batches", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn tam_dung_ghi_khoang_thoi_gian() {
        let db = StateDb::open_in_memory().unwrap();
        let t = |m: i64| DateTime::<Utc>::UNIX_EPOCH + chrono::Duration::minutes(m);
        assert!(!db.is_paused().unwrap());
        db.set_paused(false, t(0)).unwrap();
        assert!(db.pause_windows().unwrap().is_empty());

        db.set_paused(true, t(10)).unwrap();
        db.set_paused(true, t(12)).unwrap(); // pause lần hai không mở khoảng mới
        assert!(db.is_paused().unwrap());
        assert_eq!(
            db.pause_windows().unwrap(),
            vec![PauseWindow {
                start: t(10),
                end: None
            }]
        );
        db.set_paused(false, t(20)).unwrap();
        db.set_paused(true, t(30)).unwrap();
        db.set_paused(false, t(40)).unwrap();
        assert!(!db.is_paused().unwrap());
        let w = db.pause_windows().unwrap();
        assert_eq!(w.len(), 2);
        assert_eq!(
            w[0],
            PauseWindow {
                start: t(10),
                end: Some(t(20))
            }
        );
        assert!(w[0].contains(t(10)) && w[0].contains(t(19)));
        assert!(!w[0].contains(t(20)) && !w[0].contains(t(9)));
    }
}
