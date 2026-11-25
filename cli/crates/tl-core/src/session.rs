//! Kiểu dữ liệu session chuẩn hóa theo schema v1 (spec mục 5.3) — task M1-X2.
//!
//! Struct `serde` viết tay, khớp `packages/schema/session.v1.schema.json`
//! (snake_case), kèm test so với các file trong `packages/schema/examples/`.

/// Session đã chuẩn hóa, đầu ra của `Adapter::normalize`.
///
/// Placeholder cho tới khi task M1-X2 định nghĩa đầy đủ các trường theo schema v1.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct NormalizedSession {}
