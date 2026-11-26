//! `tl preview [session]` — in ĐÚNG JSON sẽ gửi (sau khi lọc phạm vi, che secret, đổi
//! đường dẫn, cắt), dạng `IngestBatch` pretty. Task M1.7.
//!
//! - Không tham số: session gần nhất **trong phạm vi**.
//! - Tham số là đường dẫn file log `.jsonl`, hoặc `source_id` (`claude_code:<uuid>` hay
//!   chỉ `<uuid>`).
//! - Session ngoài phạm vi: chỉ báo "ngoài phạm vi, sẽ không gửi", không in nội dung.
//!
//! Chỉ gọi mạng `GET /agent/v1/whoami` (lấy repo pattern), không gửi gì. JSON ra
//! stdout (`out`), dòng ghi chú ra stderr để `tl preview > payload.json` vẫn là JSON sạch.
//! `batch_id` sinh mới mỗi lần chạy nên khác với lần gửi thật.

use std::io::Write;
use std::path::Path;
use std::time::SystemTime;

use clap::Args;
use tl_adapters::{Adapter, SourceFile};
use tl_core::redact::Redactor;

use crate::context::AppContext;
use crate::error::AppError;
use crate::pipeline::batch::new_batch;
use crate::pipeline::collect::{source_file, CollectStats, Pipeline, PreparedSession};
use crate::pipeline::scope::{patterns_from_whoami, ScopeFilter};
use crate::sync::{connect, Sources};

#[derive(Debug, Args)]
pub struct PreviewArgs {
    /// Session cần xem (source_id hoặc đường dẫn file log .jsonl); bỏ trống để chọn session gần nhất trong phạm vi
    pub session: Option<String>,
}

pub async fn run(ctx: &AppContext, args: PreviewArgs, out: &mut dyn Write) -> Result<(), AppError> {
    let mut note = std::io::stderr();
    run_with(ctx, args, &Sources::from_env(), out, &mut note).await
}

/// Như [`run`] nhưng nhận nguồn log và nơi in ghi chú (để test).
pub async fn run_with(
    ctx: &AppContext,
    args: PreviewArgs,
    sources: &Sources,
    out: &mut dyn Write,
    note: &mut dyn Write,
) -> Result<(), AppError> {
    let conn = connect(ctx).await?;
    let mut filter = ScopeFilter::new(patterns_from_whoami(&conn.whoami));
    let mut pipeline = Pipeline {
        filter: &mut filter,
        redactor: Redactor::shared(),
        options: &sources.prepare,
        now: SystemTime::now(),
    };
    let adapters = sources.adapter_refs();

    let (sessions, stats) = match args.session.as_deref().map(str::trim) {
        None | Some("") => latest_in_scope(&mut pipeline, &adapters),
        Some(arg) => {
            let Some((adapter, file)) = find_file(&adapters, arg) else {
                return Err(AppError::user(
                    format!("Không tìm thấy session hoặc file log \"{arg}\"."),
                    "Truyền đường dẫn file .jsonl, hoặc source_id dạng claude_code:<uuid>; bỏ trống để xem session gần nhất.",
                ));
            };
            pipeline.process_file(adapter, &file)
        }
    };

    if sessions.is_empty() {
        match (&args.session, stats.out_of_scope) {
            (Some(_), n) if n > 0 => {
                let _ = writeln!(
                    out,
                    "Session này ngoài phạm vi (repo không thuộc project nào bạn tham gia, hoặc không nằm trong git repo), sẽ không gửi."
                );
            }
            (Some(_), _) => {
                let _ = writeln!(out, "File log này không có session nào đọc được.");
            }
            (None, _) => {
                let _ = writeln!(
                    out,
                    "Không có session nào trong phạm vi trên máy này ({} session ngoài phạm vi bị bỏ, sẽ không gửi).",
                    stats.out_of_scope
                );
            }
        }
        return Ok(());
    }

    let _ = writeln!(
        note,
        "Dữ liệu dưới đây là đúng những gì `tl sync` sẽ gửi cho {} session ({} session ngoài phạm vi đã bỏ qua khi tìm).",
        sessions.len(),
        stats.out_of_scope
    );
    let batch = new_batch(sessions.into_iter().map(|p| p.envelope).collect());
    let text = serde_json::to_string_pretty(&batch).map_err(|e| AppError::User {
        message: format!("Không tạo được JSON ({e})."),
        hint: None,
    })?;
    let _ = writeln!(out, "{text}");
    Ok(())
}

/// Session gần nhất trong phạm vi: duyệt file theo thời điểm sửa mới nhất trước, dừng ở
/// file đầu tiên có session trong phạm vi, lấy session hoạt động muộn nhất của file đó.
fn latest_in_scope(
    pipeline: &mut Pipeline<'_>,
    adapters: &[&dyn Adapter],
) -> (Vec<PreparedSession>, CollectStats) {
    let mut files: Vec<(&dyn Adapter, SourceFile)> = adapters
        .iter()
        .flat_map(|a| a.discover().into_iter().map(move |f| (*a, f)))
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.1.modified));

    let mut stats = CollectStats::default();
    for (adapter, file) in files {
        let (sessions, s) = pipeline.process_file(adapter, &file);
        stats.merge(&s);
        if let Some(best) = sessions.into_iter().max_by_key(|p| p.last_activity) {
            return (vec![best], stats);
        }
    }
    (Vec::new(), stats)
}

/// Tham số là đường dẫn file (có thật) hoặc `source_id`/uuid (khớp tên file `<uuid>.jsonl`).
fn find_file<'a>(adapters: &[&'a dyn Adapter], arg: &str) -> Option<(&'a dyn Adapter, SourceFile)> {
    let path = Path::new(arg);
    if path.is_file() {
        let adapter = *adapters.first()?;
        return source_file(adapter, path).ok().map(|f| (adapter, f));
    }
    for adapter in adapters {
        let prefix = format!("{}:", adapter.id().as_str());
        let id = arg.strip_prefix(&prefix).unwrap_or(arg);
        if let Some(file) = adapter.discover().into_iter().find(|f| {
            f.path
                .file_stem()
                .is_some_and(|s| s.eq_ignore_ascii_case(id))
        }) {
            return Some((*adapter, file));
        }
    }
    None
}
