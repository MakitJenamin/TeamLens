//! Điểm vào của `tl.exe`.

use std::io::Write;
use std::process::ExitCode;

use clap::Parser;
use teamlens::cli::Cli;
use teamlens::commands::dispatch;
use teamlens::context::AppContext;
use teamlens::error::AppError;
use teamlens::update::notice::{self, NoticeOptions, Notifier};

fn main() -> ExitCode {
    let debug = init_tracing();
    let cli = Cli::parse();
    // Nhắc có bản tl mới: đọc state.db (kiểm nhẹ nếu cần) song song với lệnh, in ở cuối.
    let notifier = Notifier::start(
        &cli.command,
        notice::default_state_path,
        NoticeOptions::from_env(),
    );

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("Lỗi: không khởi động được runtime ({e}).");
            return ExitCode::FAILURE;
        }
    };

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let result = runtime.block_on(dispatch(cli.command, AppContext::from_platform, &mut out));
    let _ = out.flush();

    let code = match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            report_error(&e, debug);
            ExitCode::from(e.exit_code())
        }
    };
    notifier.finish(&mut std::io::stderr());
    code
}

/// Bật log theo biến `TL_LOG` (ví dụ `TL_LOG=debug`). Trả `true` khi ở mức debug/trace.
fn init_tracing() -> bool {
    let filter = std::env::var("TL_LOG").unwrap_or_default();
    let debug = {
        let f = filter.to_ascii_lowercase();
        f.contains("debug") || f.contains("trace")
    };
    let env_filter =
        tracing_subscriber::EnvFilter::try_new(if filter.is_empty() { "warn" } else { &filter })
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_writer(std::io::stderr)
        .with_target(false)
        .try_init();
    debug
}

fn report_error(e: &AppError, debug: bool) {
    if let AppError::NotImplemented { .. } = e {
        eprintln!("{e}");
        return;
    }
    eprintln!("Lỗi: {e}");
    if let Some(hint) = e.hint() {
        eprintln!("Gợi ý: {hint}");
    }
    if debug {
        eprintln!();
        eprintln!("Chi tiết (TL_LOG=debug): {e:?}");
        let mut source = std::error::Error::source(e);
        while let Some(s) = source {
            eprintln!("  nguyên nhân: {s}");
            source = s.source();
        }
    } else if std::error::Error::source(e).is_some() {
        eprintln!("(Đặt TL_LOG=debug để xem chi tiết.)");
    }
}
