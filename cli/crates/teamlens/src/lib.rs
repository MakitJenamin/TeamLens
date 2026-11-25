//! TeamLens CLI (`tl.exe`).
//!
//! Binary `tl` chỉ parse tham số rồi gọi vào thư viện này, để logic test được bằng
//! integration test (xem `tests/`).

pub mod api_client;
pub mod cli;
pub mod commands;
pub mod config;
pub mod context;
pub mod error;

pub mod daemon;
pub mod pipeline;
pub mod queue;
pub mod sync;

/// Phiên bản CLI, gửi lên server (`cliVersion`, user-agent).
pub const CLI_VERSION: &str = env!("CARGO_PKG_VERSION");

/// User-agent cho mọi request HTTP.
pub fn user_agent() -> String {
    format!("teamlens-cli/{CLI_VERSION}")
}
