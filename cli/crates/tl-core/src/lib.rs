//! Logic thuần của TeamLens CLI.
//!
//! Crate này không làm I/O (không mạng, không file, không async) để mọi thứ
//! test được bằng unit test đơn giản. Các module hiện là khung, được lấp ở các task:
//!
//! | Module | Task |
//! | --- | --- |
//! | [`session`] | A1 |
//! | [`scope`] | A4 |
//! | [`redact`] | A5 |
//! | [`truncate`] | A5 |

pub mod redact;
pub mod scope;
pub mod session;
pub mod truncate;
