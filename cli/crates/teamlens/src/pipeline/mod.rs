//! Pipeline xử lý session (spec 6): adapter → lọc phạm vi → che secret → đổi đường dẫn
//! → cắt → batch. Task M1.7 (dùng kết quả M1.3, M1.4, M1.5).
//!
//! - [`git`]: đọc remote/nhánh của repo chứa `cwd` (M1.4).
//! - [`scope`]: lọc session theo repo pattern của project (M1.4).
//! - [`collect`]: chạy cả chuỗi trên các file log, bỏ session ngoài phạm vi ngay sau normalize.
//! - [`prepare`]: điền metadata repo, che secret, đổi đường dẫn, cắt (một session).
//! - [`instructions`]: `instruction_files` (chỉ kích thước, không nội dung).
//! - [`batch`]: đóng `IngestBatch`, chia theo kích thước, gzip.

pub mod batch;
pub mod collect;
pub mod git;
pub mod instructions;
pub mod prepare;
pub mod scope;
