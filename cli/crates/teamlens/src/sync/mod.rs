//! Gửi session lên `POST /agent/v1/ingest` và phần dùng chung của `tl sync`/`tl preview`.
//! Task M1.7.
//!
//! Mốc 1 gửi thẳng, không hàng đợi: mỗi lần `tl sync` gửi lại toàn bộ session trong
//! phạm vi (server idempotent theo `batch_id`, upsert theo `source_id`/`seq`).
//! M3.1 thêm hàng đợi SQLite + retry, M3.2 daemon gọi lại phần gửi ở đây.

pub mod agent_config;
pub mod consent_gate;
pub mod incremental;

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use tl_adapters::claude_code::ClaudeCodeAdapter;
use tl_adapters::codex::CodexAdapter;
use tl_adapters::Adapter;
use tl_core::session::SessionEnvelope;

use crate::api_client::{
    ApiClient, ApiError, ApiErrorCode, IngestAccepted, IngestError, IngestRejected,
};
use crate::context::AppContext;
use crate::error::AppError;
use crate::pipeline::batch::{group_envelopes, gzip_json, new_batch};
use crate::pipeline::prepare::PrepareOptions;

/// Chờ `Retry-After` tối đa bao nhiêu "giây" (đơn vị `AppContext::poll_unit`).
const MAX_RETRY_AFTER_SECS: u64 = 120;
/// Server không gửi `Retry-After` thì chờ chừng này.
const DEFAULT_RETRY_AFTER_SECS: u64 = 30;

/// Nguồn log và tùy chọn xử lý của máy; test thay bằng thư mục tạm.
pub struct Sources {
    pub adapters: Vec<Box<dyn Adapter>>,
    pub prepare: PrepareOptions,
}

impl Sources {
    /// Adapter thật của máy: Claude Code và Codex.
    pub fn from_env() -> Self {
        let mut adapters: Vec<Box<dyn Adapter>> = Vec::new();
        if let Some(cc) = ClaudeCodeAdapter::from_env() {
            adapters.push(Box::new(cc));
        }
        if let Some(codex) = CodexAdapter::from_env() {
            adapters.push(Box::new(codex));
        }
        Self {
            adapters,
            prepare: PrepareOptions::from_env(),
        }
    }

    pub fn adapter_refs(&self) -> Vec<&dyn Adapter> {
        self.adapters.iter().map(|a| a.as_ref()).collect()
    }
}

/// Đã đăng nhập: client có token, địa chỉ server và cấu hình từ server (M2.2).
pub struct Connected {
    pub server_url: String,
    pub client: ApiClient,
    /// Config từ `GET /agent/v1/config` (hoặc bản cache khi mất mạng).
    pub agent_config: agent_config::LoadedConfig,
}

/// Đọc config + token rồi tải `GET /agent/v1/config` (repo pattern, ngưỡng cắt, phiên bản).
/// Mất mạng thì dùng bản cache gần nhất của cùng server; không có cache thì lỗi.
/// Lỗi có gợi ý tiếng Việt.
pub async fn connect(ctx: &AppContext) -> Result<Connected, AppError> {
    let config = ctx.load_config()?;
    let not_logged_in = || {
        AppError::user(
            "Máy này chưa đăng nhập TeamLens.",
            "Chạy `tl join <link mời>` (link do leader gửi) trước.",
        )
    };
    let server_url = config.server_url.ok_or_else(not_logged_in)?;
    let token = ctx
        .credentials
        .get_token(&server_url)?
        .ok_or_else(not_logged_in)?;
    let client = ApiClient::new(&server_url, Some(token))?;
    let agent_config = agent_config::load(ctx, &client, &server_url)
        .await
        .map_err(login_hint)?;
    Ok(Connected {
        server_url,
        client,
        agent_config,
    })
}

/// 401 → lỗi kèm nhắc `tl join`.
fn login_hint(e: ApiError) -> AppError {
    if e.code().is_some_and(|c| {
        matches!(
            c,
            ApiErrorCode::InvalidToken | ApiErrorCode::Unauthenticated
        )
    }) || matches!(e, ApiError::Api { status: 401, .. })
    {
        return AppError::user(
            "Token của máy này không còn hiệu lực (đã hết hạn hoặc bị thu hồi).",
            "Chạy lại `tl join <link mời>` (xin leader link còn hạn) để tham gia lại.",
        );
    }
    AppError::Api(e)
}

/// Kết quả gửi cộng dồn qua mọi batch.
#[derive(Debug, Default)]
pub struct SendReport {
    pub batches: usize,
    pub duplicate_batches: usize,
    pub accepted: Vec<IngestAccepted>,
    pub rejected: Vec<IngestRejected>,
    /// Số turn server đã nhận (batch 202, session không bị từ chối) theo `source_id`.
    pub delivered_turns: HashMap<String, usize>,
}

/// Gửi toàn bộ envelope: chia batch (< `max_batch_bytes` JSON), gzip, POST.
///
/// - `413`: chia đôi batch (theo session, rồi theo turn) và gửi lại.
/// - `429`: chờ `Retry-After` (đơn vị `wait_unit`) rồi thử lại **một** lần.
/// - `401`, `403`, `426`, lỗi mạng và lỗi khác: dừng, trả lỗi kèm báo cáo phần đã gửi được
///   (`delivered_turns` cho biết turn nào đã tới server để ghi offset).
pub async fn send_all(
    client: &ApiClient,
    envelopes: Vec<SessionEnvelope>,
    max_batch_bytes: usize,
    wait_unit: Duration,
) -> (SendReport, Option<AppError>) {
    let mut report = SendReport::default();
    // Ngăn xếp các nhóm cần gửi; nhóm bị 413 được chia đôi rồi đẩy lại.
    let mut pending: Vec<Vec<SessionEnvelope>> = group_envelopes(envelopes, max_batch_bytes);
    pending.reverse();
    while let Some(group) = pending.pop() {
        match send_group(client, group.clone(), wait_unit).await {
            Ok(result) => {
                report.batches += 1;
                if result.duplicate {
                    report.duplicate_batches += 1;
                }
                let rejected: HashSet<&str> = result
                    .rejected
                    .iter()
                    .map(|r| r.source_id.as_str())
                    .collect();
                for env in group
                    .iter()
                    .filter(|e| !rejected.contains(e.session.source_id.as_str()))
                {
                    *report
                        .delivered_turns
                        .entry(env.session.source_id.clone())
                        .or_default() += env.turns.len();
                }
                report.accepted.extend(result.accepted);
                report.rejected.extend(result.rejected);
            }
            Err(IngestError::TooLarge) => match halve(group) {
                Some((a, b)) => {
                    pending.push(b);
                    pending.push(a);
                }
                None => {
                    let err = AppError::user(
                        "Một turn đơn lẻ vẫn vượt giới hạn kích thước của server.",
                        "Báo admin kiểm tra giới hạn body của server/proxy (mặc định 10 MB).",
                    );
                    return (report, Some(err));
                }
            },
            Err(e) => return (report, Some(ingest_app_error(e))),
        }
    }
    (report, None)
}

/// Gửi một nhóm thành một batch; `429` thì chờ rồi thử lại một lần (cùng `batch_id`).
async fn send_group(
    client: &ApiClient,
    group: Vec<SessionEnvelope>,
    wait_unit: Duration,
) -> Result<crate::api_client::IngestResult, IngestError> {
    let batch = new_batch(group);
    let body = gzip_json(&batch).map_err(|e| {
        IngestError::Api(ApiError::InvalidResponse {
            status: 0,
            detail: format!("không nén được batch ({e})"),
        })
    })?;
    match client.ingest_gzip(body.clone()).await {
        Err(IngestError::RateLimited { retry_after, .. }) => {
            let secs = retry_after
                .unwrap_or(DEFAULT_RETRY_AFTER_SECS)
                .min(MAX_RETRY_AFTER_SECS);
            tracing::info!(secs, "server báo gửi quá nhanh, chờ rồi thử lại");
            tokio::time::sleep(wait_unit * secs as u32).await;
            client.ingest_gzip(body).await
        }
        other => other,
    }
}

/// Chia đôi nhóm: nhiều session → theo session; một session nhiều turn → theo turn.
fn halve(mut group: Vec<SessionEnvelope>) -> Option<(Vec<SessionEnvelope>, Vec<SessionEnvelope>)> {
    if group.len() > 1 {
        let b = group.split_off(group.len() / 2);
        return Some((group, b));
    }
    let mut env = group.pop()?;
    if env.turns.len() <= 1 {
        return None;
    }
    let tail = env.turns.split_off(env.turns.len() / 2);
    let other = SessionEnvelope {
        session: env.session.clone(),
        turns: tail,
    };
    Some((vec![env], vec![other]))
}

fn ingest_app_error(e: IngestError) -> AppError {
    match e {
        IngestError::UpgradeRequired {
            min_cli_version,
            message,
        } => AppError::user(
            format!(
                "Server không nhận dữ liệu từ bản tl {} này{}.",
                crate::CLI_VERSION,
                if message.is_empty() {
                    String::new()
                } else {
                    format!(" ({message})")
                }
            ),
            match min_cli_version {
                Some(v) => format!("Cập nhật tl lên bản {v} trở lên rồi chạy lại `tl sync`."),
                None => "Cập nhật tl lên bản mới nhất rồi chạy lại `tl sync`.".to_owned(),
            },
        ),
        IngestError::RateLimited { .. } => AppError::user(
            "Server vẫn báo gửi quá nhanh sau khi đã chờ.",
            "Đợi vài phút rồi chạy lại `tl sync`.",
        ),
        IngestError::TooLarge => AppError::user(
            "Batch vượt giới hạn kích thước của server.",
            "Báo admin kiểm tra giới hạn body của server/proxy.",
        ),
        IngestError::Api(e) => {
            if e.code() == Some(&ApiErrorCode::Other("consent_required".into())) {
                return AppError::user(
                    "Thiết bị này chưa đồng ý (hoặc đã rút đồng ý) chia sẻ dữ liệu.",
                    "Chạy lại `tl join <link mời>` để xem và đồng ý.",
                );
            }
            login_hint(e)
        }
    }
}

/// Link dashboard của một session (`/projects/<project>/sessions/<id>`).
pub fn dashboard_link(server_url: &str, project_id: &str, session_id: &str) -> String {
    format!(
        "{}/projects/{project_id}/sessions/{session_id}",
        server_url.trim_end_matches('/')
    )
}
