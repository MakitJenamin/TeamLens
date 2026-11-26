//! Điểm móc consent trước khi gửi (AGENTS.md mục 3: pipeline gửi của CLI hỏi module
//! `consent` của Người 2 trước khi gửi).
//!
//! TODO(M3.1/M3.7): module `crate::consent` (Người 2) chưa có. Khi có, thay thân hàm
//! [`may_send`] bằng lời gọi sang đó (đọc trạng thái đồng ý đã lưu, `paused`...).
//! Trong lúc chờ, server vẫn là chốt chặn: ingest trả `403 consent_required` khi thiết
//! bị chưa đồng ý, và `tl sync` dừng kèm gợi ý `tl consent`.

/// Có được phép gửi dữ liệu lên server không. Hiện luôn `true` (xem TODO ở đầu module).
pub fn may_send() -> bool {
    true
}
