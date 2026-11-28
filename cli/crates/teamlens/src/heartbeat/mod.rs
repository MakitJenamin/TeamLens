//! Heartbeat `POST /agent/v1/heartbeat` (M3.3, SPEC 4.1, 4.2, 7.2).
//!
//! Thiết bị báo trạng thái (`online`/`paused`), phiên bản CLI, agent phát hiện được, số lỗi
//! parse và hàng đợi. Gửi:
//! - mỗi [`HEARTBEAT_INTERVAL`] khi daemon chạy (M3.2 gọi [`send_once`]);
//! - một lần cuối mỗi `tl sync`;
//! - ngay khi `tl pause` / `tl resume`.
//!
//! Kết quả lần gửi gần nhất lưu trong `state.db` (`meta`) để `tl status` hiển thị.
//! Chỉ gửi số đếm và phiên bản, không có gì về nội dung session.

use chrono::{DateTime, Utc};

use crate::api_client::{
    ApiClient, ApiError, DeviceRunStatus, HeartbeatAgent, HeartbeatQueue, HeartbeatRequest,
    HeartbeatResult,
};
use crate::context::AppContext;
use crate::error::AppError;
use crate::state::{state_path, StateDb};
use crate::sync::Sources;

/// Chu kỳ heartbeat của daemon (spec 4.1). Server coi thiết bị offline sau 30 phút im lặng.
pub const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Khóa `meta`: thời điểm (RFC 3339) server nhận heartbeat gần nhất.
pub const LAST_AT_KEY: &str = "heartbeat.last_at";
/// Khóa `meta`: trạng thái server trả về ở heartbeat gần nhất.
pub const LAST_STATUS_KEY: &str = "heartbeat.last_status";
/// Khóa `meta`: lỗi của lần gửi heartbeat gần nhất (rỗng khi thành công).
pub const LAST_ERROR_KEY: &str = "heartbeat.last_error";
/// Tiền tố khóa `meta` lưu phiên bản agent đọc được từ session trong phạm vi (`tl sync` ghi).
const AGENT_VERSION_PREFIX: &str = "agent_version.";

/// Khóa `meta` lưu phiên bản của agent (`claude_code`, `codex`...).
pub fn agent_version_key(agent: &str) -> String {
    format!("{AGENT_VERSION_PREFIX}{agent}")
}

/// Agent có file log trên máy, kèm phiên bản gần nhất đã thấy (nếu có).
pub fn detect_agents(sources: &Sources, db: Option<&StateDb>) -> Vec<HeartbeatAgent> {
    sources
        .adapter_refs()
        .into_iter()
        .filter_map(|adapter| {
            let files = adapter.discover().len() as u64;
            if files == 0 {
                return None;
            }
            let agent = adapter.id().as_str().to_owned();
            let version = db
                .and_then(|db| db.meta(&agent_version_key(&agent)).ok().flatten())
                .filter(|v| !v.is_empty());
            Some(HeartbeatAgent {
                agent,
                version,
                files,
            })
        })
        .collect()
}

/// Số liệu hàng đợi gửi offline (M3.1, [`crate::queue::queue_stats`]); lỗi đọc thì 0.
pub fn queue_stats(db: &StateDb) -> HeartbeatQueue {
    match crate::queue::queue_stats(db) {
        Ok(q) => HeartbeatQueue {
            batches: q.pending_batches,
            bytes: q.pending_bytes,
            dropped: q.dropped_batches,
            failed: q.failed_batches,
        },
        Err(e) => {
            tracing::debug!(error = %e, "không đọc được hàng đợi cho heartbeat");
            HeartbeatQueue::default()
        }
    }
}

/// Dựng body heartbeat từ `state.db` và nguồn log của máy.
pub fn build_request(sources: &Sources, db: &StateDb) -> Result<HeartbeatRequest, AppError> {
    let state = |e: rusqlite::Error| {
        tracing::debug!(error = %e, "lỗi state.db khi dựng heartbeat");
        AppError::user(
            "Không đọc được state.db.",
            "Kiểm tra quyền ghi thư mục %LOCALAPPDATA%\\teamlens.",
        )
    };
    let status = if db.is_paused().map_err(state)? {
        DeviceRunStatus::Paused
    } else {
        DeviceRunStatus::Online
    };
    Ok(HeartbeatRequest {
        status,
        cli_version: crate::CLI_VERSION.to_owned(),
        agents: detect_agents(sources, Some(db)),
        parse_errors: db.parse_error_total().map_err(state)?,
        queue: queue_stats(db),
        sent_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    })
}

/// Client của server hiện tại nếu máy đã đăng nhập (không gọi mạng).
pub fn client_for(ctx: &AppContext) -> Result<Option<ApiClient>, AppError> {
    let config = ctx.load_config()?;
    let Some(server_url) = config.server_url else {
        return Ok(None);
    };
    let Some(token) = ctx.credentials.get_token(&server_url)? else {
        return Ok(None);
    };
    Ok(Some(ApiClient::new(&server_url, Some(token))?))
}

/// Gửi một heartbeat và ghi kết quả vào `state.db`. Daemon (M3.2) gọi mỗi
/// [`HEARTBEAT_INTERVAL`]; trạng thái (`online`/`paused`) lấy theo cờ `tl pause`.
pub async fn send_once(
    ctx: &AppContext,
    client: &ApiClient,
    sources: &Sources,
) -> Result<HeartbeatResult, AppError> {
    let db = StateDb::open(&state_path(&ctx.config_path))?;
    let body = build_request(sources, &db)?;
    let result = client.heartbeat(&body).await;
    record(&db, &result);
    result.map_err(AppError::Api)
}

/// Ghi kết quả gửi vào `meta` (lỗi ghi chỉ log, không làm hỏng lệnh).
fn record(db: &StateDb, result: &Result<HeartbeatResult, ApiError>) {
    let r = match result {
        Ok(res) => db
            .set_meta(LAST_AT_KEY, &Utc::now().to_rfc3339())
            .and_then(|()| db.set_meta(LAST_STATUS_KEY, &res.status))
            .and_then(|()| db.set_meta(LAST_ERROR_KEY, "")),
        Err(e) => db.set_meta(LAST_ERROR_KEY, &e.to_string()),
    };
    if let Err(e) = r {
        tracing::debug!(error = %e, "không ghi được kết quả heartbeat vào state.db");
    }
}

/// Heartbeat gần nhất đã ghi trong `state.db`.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastHeartbeat {
    /// Lúc server nhận thành công lần gần nhất.
    pub at: Option<DateTime<Utc>>,
    /// Trạng thái server trả về lúc đó (`online`, `paused`, `consent_revoked`).
    pub status: Option<String>,
    /// Lỗi của lần gửi gần nhất, nếu lần đó thất bại.
    pub error: Option<String>,
}

pub fn last(db: &StateDb) -> LastHeartbeat {
    let get = |k: &str| db.meta(k).ok().flatten().filter(|v| !v.is_empty());
    LastHeartbeat {
        at: get(LAST_AT_KEY)
            .and_then(|v| DateTime::parse_from_rfc3339(&v).ok())
            .map(|t| t.with_timezone(&Utc)),
        status: get(LAST_STATUS_KEY),
        error: get(LAST_ERROR_KEY),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_theo_co_tam_dung_va_loi_parse() {
        let db = StateDb::open_in_memory().unwrap();
        let sources = Sources {
            adapters: Vec::new(),
            prepare: Default::default(),
        };
        let body = build_request(&sources, &db).unwrap();
        assert_eq!(body.status, DeviceRunStatus::Online);
        assert_eq!(body.parse_errors, 0);
        assert_eq!(body.queue, HeartbeatQueue::default());
        assert!(body.agents.is_empty());

        db.set_paused(true, Utc::now()).unwrap();
        db.record_parse_errors(std::path::Path::new("a.jsonl"), "codex", 2, false)
            .unwrap();
        let body = build_request(&sources, &db).unwrap();
        assert_eq!(body.status, DeviceRunStatus::Paused);
        assert_eq!(body.parse_errors, 2);
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["status"], "paused");
        assert!(json["sent_at"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn ghi_va_doc_lai_heartbeat_gan_nhat() {
        let db = StateDb::open_in_memory().unwrap();
        assert_eq!(last(&db), LastHeartbeat::default());
        record(
            &db,
            &Ok(HeartbeatResult {
                status: "paused".into(),
                consent_text_version: "v".into(),
                min_cli_version: "0.1.0".into(),
            }),
        );
        let l = last(&db);
        assert!(l.at.is_some());
        assert_eq!(l.status.as_deref(), Some("paused"));
        assert_eq!(l.error, None);

        record(
            &db,
            &Err(ApiError::InvalidResponse {
                status: 500,
                detail: "lỗi".into(),
            }),
        );
        let l2 = last(&db);
        assert_eq!(l2.at, l.at, "lỗi không xóa lần thành công trước");
        assert!(l2.error.is_some());
    }
}
