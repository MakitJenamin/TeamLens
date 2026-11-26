//! Logic thuần của TeamLens CLI.
//!
//! Crate này không làm I/O (không mạng, không file, không async) để mọi thứ
//! test được bằng unit test đơn giản. Các module hiện là khung, được lấp ở các task:
//!
//! | Module | Task |
//! | --- | --- |
//! | [`session`] | M1.2 |
//! | [`scope`] | M1.4 |
//! | [`redact`] | M1.5, M2.1 |
//! | [`truncate`] | M1.5 |
//! | [`paths`] | M1.5 |
//! | [`sensitive`] | M2.1 |

pub mod paths;
pub mod redact;
pub mod scope;
pub mod sensitive;
pub mod session;
pub mod truncate;
