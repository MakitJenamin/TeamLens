//! Cầu nối MCP stdio ↔ HTTP (M6.4, `tl mcp`).
//!
//! Claude Code, Codex và các agent khác nói MCP qua stdio (mỗi dòng một message JSON-RPC 2.0), còn
//! server TeamLens nói qua HTTP (`POST /api/v1/mcp`, không giữ phiên). `tl mcp` đọc từng dòng từ stdin,
//! chuyển nguyên văn lên server bằng device token của máy, rồi in phản hồi ra stdout (mỗi message một
//! dòng). Không có logic tool nào ở đây.
//!
//! Quy tắc:
//! - **stdout chỉ chứa message giao thức**; mọi thông báo cho người đọc đi ra stderr (qua `tracing`).
//! - Lỗi mạng, token hỏng hoặc server báo lỗi được trả về thành **lỗi JSON-RPC cho đúng request**
//!   (có `id`), để agent đọc được lý do thay vì chờ mãi. Notification (không có `id`) lỗi thì chỉ log.
//! - Xử lý tuần tự từng message: giữ đúng thứ tự phản hồi, đủ cho bộ tool hiện tại.

use std::io::Write;

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

use crate::api_client::{ApiClient, ApiError, ApiErrorCode};

/// Mã lỗi JSON-RPC: lỗi phân tích cú pháp (theo đặc tả JSON-RPC 2.0).
const PARSE_ERROR: i64 = -32700;
/// Mã lỗi JSON-RPC dành cho lỗi của server/cầu nối (dải -32000..-32099 do ứng dụng định nghĩa).
const SERVER_ERROR: i64 = -32000;

/// Đọc stdin đến hết, mỗi dòng không rỗng là một message (hoặc một mảng batch) JSON-RPC.
pub async fn serve<R: AsyncBufRead + Unpin>(
    client: &ApiClient,
    mut input: R,
    out: &mut dyn Write,
) -> std::io::Result<()> {
    let mut line = String::new();
    loop {
        line.clear();
        if input.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        for reply in handle_line(client, text).await {
            write_message(out, &reply)?;
        }
    }
}

/// Xử lý một dòng đầu vào, trả về các message cần in ra stdout.
async fn handle_line(client: &ApiClient, text: &str) -> Vec<Value> {
    let parsed: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(e) => {
            tracing::debug!(error = %e, "dòng không phải JSON");
            return vec![error_message(
                Value::Null,
                PARSE_ERROR,
                "Message không phải JSON hợp lệ.",
            )];
        }
    };
    // Chuyển nguyên văn đã gọn một dòng (không chứa xuống dòng), không dựng lại nội dung.
    match client.mcp_post(parsed.to_string()).await {
        Ok(messages) => messages
            .iter()
            .filter_map(|m| match serde_json::from_str::<Value>(m) {
                Ok(value) => Some(value),
                Err(e) => {
                    tracing::warn!(error = %e, "server trả message không phải JSON, bỏ qua");
                    None
                }
            })
            .collect(),
        Err(e) => {
            let message = describe(&e);
            tracing::warn!("{message}");
            request_ids(&parsed)
                .into_iter()
                .map(|id| error_message(id, SERVER_ERROR, &message))
                .collect()
        }
    }
}

/// `id` của mọi *request* (có `method` và `id`) trong một message hoặc batch; notification không có.
fn request_ids(value: &Value) -> Vec<Value> {
    let one = |v: &Value| -> Option<Value> {
        let object = v.as_object()?;
        if object.contains_key("method") {
            object.get("id").filter(|id| !id.is_null()).cloned()
        } else {
            None
        }
    };
    match value {
        Value::Array(items) => items.iter().filter_map(one).collect(),
        other => one(other).into_iter().collect(),
    }
}

fn error_message(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Thông báo tiếng Việt cho agent (và người đọc log), kèm cách sửa khi biết.
fn describe(error: &ApiError) -> String {
    match error {
        ApiError::Api {
            code: ApiErrorCode::InvalidToken | ApiErrorCode::Unauthenticated,
            ..
        } => "Token của máy này không còn hiệu lực. Chạy `tl join <link mời>` để tham gia lại."
            .into(),
        ApiError::Network { url, .. } => {
            format!("Không kết nối được tới server TeamLens {url}. Kiểm tra mạng rồi thử lại.")
        }
        other => other.to_string(),
    }
}

/// In một message trên đúng một dòng rồi flush ngay (client đang chờ).
fn write_message(out: &mut dyn Write, message: &Value) -> std::io::Result<()> {
    writeln!(out, "{message}")?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_chi_lay_request_co_id() {
        let request = json!({"jsonrpc":"2.0","id":7,"method":"tools/list"});
        let notification = json!({"jsonrpc":"2.0","method":"notifications/initialized"});
        let response = json!({"jsonrpc":"2.0","id":9,"result":{}});
        let null_id = json!({"jsonrpc":"2.0","id":null,"method":"x"});
        assert_eq!(request_ids(&request), vec![json!(7)]);
        assert!(request_ids(&notification).is_empty());
        assert!(request_ids(&response).is_empty());
        assert!(request_ids(&null_id).is_empty());
        assert_eq!(
            request_ids(&json!([request, notification, {"id":"a","method":"m"}])),
            vec![json!(7), json!("a")]
        );
    }

    #[test]
    fn error_message_dung_dinh_dang_json_rpc() {
        let value = error_message(json!(3), SERVER_ERROR, "loi");
        assert_eq!(
            value,
            json!({"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"loi"}})
        );
    }
}
