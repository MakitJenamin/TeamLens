//! Hàng đợi offline SQLite (`state.db`): offset từng file, batch chờ gửi, retry/backoff, giới hạn 500 MB, xử lý `426`. Task M3-Y1 (offset: M2-Y2).
