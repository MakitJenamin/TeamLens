//! Gửi tăng dần theo trạng thái trong `state.db` (task M2.3).
//!
//! Bộ chuẩn hóa cần ngữ cảnh cả file (usage theo `message.id`, ghép tool_use ↔
//! tool_result, đánh `seq` theo thứ tự), nên **không** đọc thật từ offset byte giữa
//! file. Cách làm:
//!
//! 1. File không đổi (kích thước + mtime như lần gửi xong trước) → bỏ qua, không đọc.
//! 2. File đổi nhưng chưa ổn định (sửa < [`STABLE_AFTER`]) → chờ, không đọc, trừ khi
//!    có `--include-active`.
//! 3. File đổi và ổn định → đọc + chuẩn hóa cả file, nhưng mỗi session chỉ đưa vào
//!    batch các turn có `seq` ≥ `resend_from` đã lưu (kèm metadata session, `ended_at`
//!    mới). `resend_from` là `seq` nhỏ nhất trong số: turn cuối, turn assistant cuối
//!    (có thể bị đánh dấu `interrupted`), tool_call chưa có kết quả (tool_result tới
//!    sau sẽ sửa `status`/`diff` của nó). Server upsert `(session_id, seq)` nên gửi lại
//!    các turn này an toàn.
//! 4. File ngắn lại (bị cắt/thay mới) → quên tiến độ, gửi lại từ đầu.
//!
//! Trạng thái chỉ được chốt **sau khi** server trả 202 cho mọi batch chứa turn của file
//! đó (M3.1: batch nằm trong hàng đợi, tiến độ "đặt chỗ" chờ trong `queue_reservations`;
//! lần quét sau so với bản đặt chỗ nên không xếp hàng lại nội dung đã có trong hàng đợi).

use std::time::SystemTime;

use tl_adapters::SourceFile;
use tl_core::session::{Role, Turn, TurnKind};

use crate::api_client::AgentConfig;
use crate::consent::ConsentState;
use crate::pipeline::collect::{PreparedSession, STABLE_AFTER};
use crate::state::{mtime_ns, FileState, PauseWindow, SessionProgress};

/// Khóa `meta` lưu dấu vân tay phạm vi gửi.
pub const SCOPE_META_KEY: &str = "scope_fingerprint";

/// Việc cần làm với một file log ở lần quét này.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileStatus {
    /// Không đổi từ lần gửi xong trước: không đọc.
    Unchanged,
    /// Còn đang được ghi (chưa ổn định): chờ lần sau.
    Waiting,
    /// Cần đọc và gửi; `reset` = quên tiến độ cũ, gửi lại từ đầu.
    Ready { reset: bool },
}

/// File còn đang được ghi (sửa trong vòng [`STABLE_AFTER`], hoặc không biết mtime).
pub fn is_active(file: &SourceFile, now: SystemTime) -> bool {
    file.modified
        .and_then(|m| now.duration_since(m).ok())
        .is_none_or(|age| age < STABLE_AFTER)
}

/// Xếp loại file so với trạng thái đã lưu.
pub fn classify(
    file: &SourceFile,
    prev: Option<&FileState>,
    now: SystemTime,
    include_active: bool,
) -> FileStatus {
    let active = is_active(file, now);
    let same = prev.is_some_and(|p| p.size == file.size && p.mtime_ns == mtime_ns(file.modified));
    if same && !prev.is_some_and(|p| p.sent_while_active) {
        return FileStatus::Unchanged;
    }
    // Gửi lúc còn đang ghi, nay vẫn đang ghi và không đổi: chưa có gì mới.
    if same && active {
        return FileStatus::Unchanged;
    }
    if active && !include_active {
        return FileStatus::Waiting;
    }
    let reset = prev.is_some_and(|p| file.size < p.size);
    FileStatus::Ready { reset }
}

/// `seq` cần gửi lại ở lần sau (xem mô tả module). `turns` phải khác rỗng.
pub fn resend_from(turns: &[Turn]) -> u32 {
    let last = turns.last().map_or(0, |t| t.seq);
    let last_assistant = turns
        .iter()
        .rev()
        .find(|t| t.role == Role::Assistant)
        .map(|t| t.seq);
    let open_call = turns
        .iter()
        .find(|t| {
            t.kind == TurnKind::ToolCall && t.tool.as_ref().is_none_or(|x| x.status.is_none())
        })
        .map(|t| t.seq);
    [Some(last), last_assistant, open_call]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(0)
}

/// Một session đã cắt bớt phần đã gửi, kèm tiến độ sẽ ghi nếu gửi thành công.
#[derive(Debug, Clone)]
pub struct PlannedSession {
    pub prepared: PreparedSession,
    pub progress: SessionProgress,
}

impl PlannedSession {
    /// Bỏ các turn `seq` < `resend_from` đã lưu. `prev = None` → gửi cả session.
    pub fn new(mut prepared: PreparedSession, prev: Option<&SessionProgress>) -> Self {
        let turns = &prepared.envelope.turns;
        let sent_turns = turns
            .last()
            .map_or(0, |t| t.seq.saturating_add(1))
            .max(u32::try_from(turns.len()).unwrap_or(u32::MAX));
        let progress = SessionProgress {
            source_id: prepared.envelope.session.source_id.clone(),
            sent_turns,
            resend_from: resend_from(turns),
        };
        if let Some(prev) = prev {
            // Luôn giữ ít nhất turn cuối để envelope hợp lệ (schema: `turns` ≥ 1).
            let from = prev.resend_from.min(progress.resend_from);
            prepared.envelope.turns.retain(|t| t.seq >= from);
        }
        Self { prepared, progress }
    }

    /// Bỏ turn có `ts` nằm trong một khoảng `tl pause` → `tl resume` (không bao giờ gửi).
    /// Turn còn lại giữ nguyên `seq` gốc (server upsert theo `(session_id, seq)`, không cần
    /// liền nhau). Tiến độ vẫn tính theo cả session nên turn bị bỏ không bị xét lại.
    /// Hết turn thì session không được gửi lần này. Trả số turn đã bỏ.
    pub fn drop_paused_turns(&mut self, windows: &[PauseWindow]) -> usize {
        if windows.is_empty() {
            return 0;
        }
        let turns = &mut self.prepared.envelope.turns;
        let before = turns.len();
        turns.retain(|t| !windows.iter().any(|w| w.contains(t.ts)));
        before - turns.len()
    }

    pub fn turn_count(&self) -> usize {
        self.prepared.envelope.turns.len()
    }
}

/// Kế hoạch gửi của một file.
#[derive(Debug, Clone)]
pub struct FilePlan {
    pub file: SourceFile,
    /// File còn đang được ghi lúc đọc (chỉ xảy ra với `--include-active`).
    pub active: bool,
    pub reset: bool,
    pub prev: Option<FileState>,
    pub sessions: Vec<PlannedSession>,
}

impl FilePlan {
    /// Trạng thái ghi vào `state.db` khi mọi batch chứa các turn của file đã tới server
    /// (lúc xếp hàng ghi thành bản "đặt chỗ", xem [`crate::queue`]).
    pub fn target_state(&self) -> FileState {
        let mut sessions: Vec<SessionProgress> = match (&self.prev, self.reset) {
            (Some(p), false) => p.sessions.clone(),
            _ => Vec::new(),
        };
        for s in &self.sessions {
            sessions.retain(|x| x.source_id != s.progress.source_id);
            sessions.push(s.progress.clone());
        }
        sessions.sort_by(|a, b| a.source_id.cmp(&b.source_id));
        FileState {
            agent: self.file.agent.as_str().to_owned(),
            size: self.file.size,
            mtime_ns: mtime_ns(self.file.modified),
            byte_offset: self.file.size,
            sent_while_active: self.active && !self.sessions.is_empty(),
            sessions,
        }
    }
}

/// Dấu vân tay của "phạm vi gửi": server, repo pattern, project đã đồng ý. Đổi thì quên
/// mọi offset để session trước đó bị lọc (ngoài phạm vi, chưa đồng ý) được xét lại.
pub fn scope_fingerprint(
    server_url: &str,
    config: &AgentConfig,
    consent: Option<&ConsentState>,
) -> String {
    let mut patterns: Vec<String> = config
        .repo_patterns
        .iter()
        .map(|p| format!("{}={}", p.project_id, p.pattern))
        .collect();
    patterns.sort();
    let mut consented: Vec<String> = consent
        .map(|c| {
            c.projects
                .iter()
                .map(|p| format!("{}:{}:{}", p.project_id, p.backfill, p.text_version))
                .collect()
        })
        .unwrap_or_default();
    consented.sort();
    format!(
        "server={}|patterns={}|consent={}",
        server_url.trim_end_matches('/'),
        patterns.join(";"),
        consented.join(";")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use std::path::PathBuf;
    use std::time::Duration;
    use tl_core::session::{AgentKind, Tool, ToolStatus};

    fn file(size: u64, age_secs: u64, now: SystemTime) -> SourceFile {
        SourceFile {
            agent: AgentKind::ClaudeCode,
            path: PathBuf::from("a.jsonl"),
            size,
            modified: Some(now - Duration::from_secs(age_secs)),
        }
    }

    fn state_of(f: &SourceFile, active: bool) -> FileState {
        FileState {
            agent: "claude_code".into(),
            size: f.size,
            mtime_ns: mtime_ns(f.modified),
            byte_offset: f.size,
            sent_while_active: active,
            sessions: Vec::new(),
        }
    }

    #[test]
    fn xep_loai_file() {
        let now = SystemTime::now();
        let stable = file(100, 600, now);
        let fresh = file(100, 10, now);
        assert_eq!(
            classify(&stable, None, now, false),
            FileStatus::Ready { reset: false }
        );
        assert_eq!(classify(&fresh, None, now, false), FileStatus::Waiting);
        assert_eq!(
            classify(&fresh, None, now, true),
            FileStatus::Ready { reset: false }
        );
        let saved = state_of(&stable, false);
        assert_eq!(
            classify(&stable, Some(&saved), now, false),
            FileStatus::Unchanged
        );
        // Ngắn lại → gửi lại từ đầu.
        let shorter = file(50, 600, now);
        assert_eq!(
            classify(&shorter, Some(&saved), now, false),
            FileStatus::Ready { reset: true }
        );
        // Gửi lúc còn ghi, nay ổn định → gửi lại để chốt `ended_at`.
        let saved_active = state_of(&stable, true);
        assert_eq!(
            classify(&stable, Some(&saved_active), now, false),
            FileStatus::Ready { reset: false }
        );
        let saved_active_fresh = state_of(&fresh, true);
        assert_eq!(
            classify(&fresh, Some(&saved_active_fresh), now, true),
            FileStatus::Unchanged
        );
    }

    fn turn(seq: u32, role: Role, kind: TurnKind) -> Turn {
        Turn::new(
            seq,
            role,
            kind,
            Utc.with_ymd_and_hms(2026, 11, 27, 9, 0, 0).unwrap(),
        )
    }

    fn call(seq: u32, status: Option<ToolStatus>) -> Turn {
        let mut t = turn(seq, Role::Assistant, TurnKind::ToolCall);
        t.tool = Some(Tool {
            name: "Bash".into(),
            input: None,
            status,
        });
        t
    }

    #[test]
    fn resend_from_lay_turn_co_the_con_doi() {
        // prompt, reply, call(ok), result, prompt → assistant cuối là seq 2.
        let turns = vec![
            turn(0, Role::User, TurnKind::Prompt),
            turn(1, Role::Assistant, TurnKind::Reply),
            call(2, Some(ToolStatus::Ok)),
            turn(3, Role::User, TurnKind::ToolResult),
            turn(4, Role::User, TurnKind::Prompt),
        ];
        assert_eq!(resend_from(&turns), 2);
        // tool_call chưa có kết quả ở seq 1 → gửi lại từ 1.
        let turns = vec![
            turn(0, Role::User, TurnKind::Prompt),
            call(1, None),
            call(2, Some(ToolStatus::Ok)),
            turn(3, Role::User, TurnKind::ToolResult),
        ];
        assert_eq!(resend_from(&turns), 1);
        // Chỉ có prompt → turn cuối.
        let turns = vec![
            turn(0, Role::User, TurnKind::Prompt),
            turn(1, Role::User, TurnKind::Prompt),
        ];
        assert_eq!(resend_from(&turns), 1);
    }
}
