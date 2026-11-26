//! Điểm móc consent trước khi gửi (AGENTS.md mục 3: pipeline gửi của CLI hỏi module
//! [`crate::consent`] trước khi gửi).
//!
//! Server vẫn là chốt chặn cuối: ingest trả `403 consent_required` khi thiết bị chưa
//! đồng ý, và `tl sync` dừng kèm gợi ý `tl join`.

use crate::context::AppContext;

/// Có được phép gửi dữ liệu lên server đang cấu hình không: `true` chỉ khi máy đã đồng ý
/// (qua `tl join`) cho đúng server đó. Không đọc được config thì coi như chưa đồng ý.
pub fn may_send(ctx: &AppContext) -> bool {
    match ctx.load_config() {
        Ok(config) => crate::consent::may_send(&config),
        Err(e) => {
            tracing::debug!(error = ?e, "không đọc được config khi kiểm tra đồng ý");
            false
        }
    }
}
