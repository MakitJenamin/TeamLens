//! Pipeline xử lý session: adapter → lọc phạm vi → che secret → cắt output → batch. Task M1.7 (dùng kết quả M1.3, M1.4, M1.5).
//!
//! - [`git`]: đọc remote/nhánh của repo chứa `cwd` (M1.4).
//! - [`scope`]: lọc session theo repo pattern của project (M1.4).

pub mod git;
pub mod scope;
