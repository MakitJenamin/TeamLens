//! Logic thuần của TeamLens CLI.
//!
//! Crate này không làm I/O (không mạng, không file, không async) để mọi thứ
//! test được bằng unit test đơn giản. Các module hiện là khung, được lấp ở các task:
//!
//! | Module | Task |
//! | --- | --- |
//! | [`session`] | M1-X2 |
//! | [`scope`] | M1-X4 |
//! | [`redact`] | M1-X5, M2-Y1 |
//! | [`truncate`] | M1-X5 |

pub mod redact;
pub mod scope;
pub mod session;
pub mod truncate;
