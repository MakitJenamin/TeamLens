//! `tl preview [session]` — in ĐÚNG JSON sẽ gửi (sau khi lọc phạm vi, che secret, đổi
//! đường dẫn, cắt), dạng `IngestBatch` pretty. Task M1.7.
//!
//! - Không tham số: session gần nhất **trong phạm vi**.
//! - Tham số là đường dẫn file log `.jsonl`, hoặc `source_id` (`claude_code:<uuid>`,
//!   `codex:<uuid>` hay chỉ `<uuid>`). File Codex tên `rollout-<thời điểm>-<uuid>.jsonl`
//!   nên khớp theo đuôi tên file.
//! - Session ngoài phạm vi: chỉ báo "ngoài phạm vi, sẽ không gửi", không in nội dung.
//!
//! Chỉ gọi mạng `GET /agent/v1/config` (repo pattern, ngưỡng cắt; mất mạng thì dùng cache),
//! không gửi gì. JSON ra
//! stdout (`out`), dòng ghi chú ra stderr để `tl preview > payload.json` vẫn là JSON sạch.
//! `batch_id` sinh mới mỗi lần chạy nên khác với lần gửi thật.

use std::io::Write;
use std::path::Path;
use std::time::SystemTime;

use clap::Args;
use tl_adapters::codex::CodexAdapter;
use tl_adapters::{Adapter, AgentKind, SourceFile};

use crate::context::AppContext;
use crate::error::AppError;
use crate::pipeline::batch::new_batch;
use crate::pipeline::collect::{source_file, CollectStats, Pipeline, PreparedSession};
use crate::pipeline::prepare::build_redactor;
use crate::pipeline::scope::ScopeFilter;
use crate::state::{state_path, StateDb};
use crate::sync::agent_config;
use crate::sync::{connect, Sources};

#[derive(Debug, Args)]
pub struct PreviewArgs {
    /// source_id hoặc đường dẫn file .jsonl. Bỏ trống để xem session gần nhất
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
    let server_config = &conn.agent_config.config;
    crate::commands::sync::print_config_source(note, &conn.agent_config.source);
    // Preview không gửi nên không dừng, chỉ báo trước là `tl sync` sẽ dừng.
    if let Err(block) =
        agent_config::check_send(&ctx.load_config()?, server_config, crate::CLI_VERSION)
    {
        let e = block.to_error();
        let _ = writeln!(note, "Lưu ý: {e}");
    }
    let prepare = agent_config::apply_to_prepare(&sources.prepare, server_config);
    let (redactor, warnings) = build_redactor(&prepare.server_redaction_patterns);
    for warning in &warnings {
        let _ = writeln!(note, "Cảnh báo: {warning}");
    }
    let mut filter = ScopeFilter::new(agent_config::repo_patterns(server_config));
    let mut pipeline = Pipeline {
        filter: &mut filter,
        redactor: &redactor,
        options: &prepare,
        now: SystemTime::now(),
    };
    let adapters = sources.adapter_refs();

    let (sessions, stats) = match args.session.as_deref().map(str::trim) {
        None | Some("") => latest_in_scope(&mut pipeline, &adapters),
        Some(arg) => {
            let Some((adapter, file)) = find_file(&adapters, arg) else {
                return Err(AppError::user(
                    format!("Không tìm thấy session hoặc file log \"{arg}\"."),
                    "Truyền đường dẫn file .jsonl hoặc source_id, ví dụ `claude_code:<uuid>`.",
                ));
            };
            pipeline.process_file(adapter, &file)
        }
    };

    // Như `tl sync`: turn phát sinh lúc `tl pause` không bao giờ gửi.
    let mut sessions = sessions;
    let state_file = state_path(&ctx.config_path);
    let windows = if state_file.exists() {
        StateDb::open(&state_file)?
            .pause_windows()
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut dropped_paused = 0usize;
    if !windows.is_empty() {
        for p in &mut sessions {
            let before = p.envelope.turns.len();
            p.envelope
                .turns
                .retain(|t| !windows.iter().any(|w| w.contains(t.ts)));
            dropped_paused += before - p.envelope.turns.len();
        }
        sessions.retain(|p| !p.envelope.turns.is_empty());
    }
    if dropped_paused > 0 {
        let _ = writeln!(note, "Bỏ {dropped_paused} turn trong lúc tạm dừng.");
    }

    if sessions.is_empty() {
        match (&args.session, stats.out_of_scope) {
            (Some(_), n) if n > 0 => {
                let _ = writeln!(
                    out,
                    "Session này ngoài phạm vi project của bạn, sẽ không gửi."
                );
            }
            (Some(_), _) => {
                let _ = writeln!(out, "File log này không có session nào đọc được.");
            }
            (None, _) => {
                let _ = writeln!(out, "Không có session nào trong phạm vi.");
            }
        }
        return Ok(());
    }

    let _ = writeln!(
        note,
        "Dữ liệu `tl sync` sẽ gửi cho {} session:",
        sessions.len()
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

/// Tham số là đường dẫn file (có thật) hoặc `source_id`/uuid: khớp tên file `<uuid>.jsonl`
/// (Claude Code) hoặc `rollout-...-<uuid>.jsonl` (Codex).
fn find_file<'a>(adapters: &[&'a dyn Adapter], arg: &str) -> Option<(&'a dyn Adapter, SourceFile)> {
    let path = Path::new(arg);
    if path.is_file() {
        // File rollout thì dùng adapter Codex, còn lại adapter đầu tiên (Claude Code).
        let wanted = if CodexAdapter::is_rollout_file(path) {
            AgentKind::Codex
        } else {
            AgentKind::ClaudeCode
        };
        let adapter = adapters
            .iter()
            .find(|a| a.id() == wanted)
            .or_else(|| adapters.first())
            .copied()?;
        return source_file(adapter, path).ok().map(|f| (adapter, f));
    }
    for adapter in adapters {
        let prefix = format!("{}:", adapter.id().as_str());
        let id = arg.strip_prefix(&prefix).unwrap_or(arg);
        if id.is_empty() {
            continue;
        }
        let rollout_suffix = format!("-{}", id.to_ascii_lowercase());
        if let Some(file) = adapter.discover().into_iter().find(|f| {
            f.path
                .file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| {
                    s.eq_ignore_ascii_case(id)
                        || (adapter.id() == AgentKind::Codex
                            && s.to_ascii_lowercase().ends_with(&rollout_suffix))
                })
        }) {
            return Some((*adapter, file));
        }
    }
    None
}
