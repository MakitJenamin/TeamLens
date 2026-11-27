//! `tl join <link mời>` (tên gọi khác: `tl login <link mời>`) — lệnh duy nhất thành viên
//! cần chạy (SPEC 4.3, 7.1).
//!
//! 1. Tách địa chỉ server và mã mời từ link `https://<server>/i/<mã>`.
//! 2. `GET /agent/v1/invites/{code}` → màn hình đồng ý trong terminal: server, project,
//!    repo sẽ thu thập, văn bản đồng ý; hỏi tên hiển thị, hỏi backfill (Enter: có). Trả lời xong là đồng ý.
//!    Từ chối thì thoát, không gọi `join`, không lưu gì.
//! 3. `POST /agent/v1/join` (kèm Bearer nếu máy đã có token còn hiệu lực cho server đó).
//!    `409 consent_outdated` → xem trước lại và hỏi lại.
//! 4. Lưu token (chỉ khi server trả token mới) vào Credential Manager, lưu server và bản
//!    đồng ý vào config.
//!
//! 5. Đăng ký `tl daemon` chạy nền khi đăng nhập Windows (Task Scheduler, M3.8) và chạy ngay.
//!    Việc này nằm ở [`run`], không ở [`run_with`], để test không đụng Task Scheduler thật.
//!    Đăng ký lỗi thì chỉ cảnh báo: người dùng vẫn đã tham gia và dùng được `tl sync`.

use std::io::{BufRead, Write};
use std::path::Path;
use std::time::SystemTime;

use chrono::{DateTime, Local, Utc};
use clap::Args;
use tl_adapters::Adapter;
use tl_platform::Platform;

use crate::api_client::{
    ApiClient, ApiError, ApiErrorCode, InvitePreview, JoinConsent, JoinRequest, JoinResult,
};
use crate::config::normalize_server_url;
use crate::consent::{self, ProjectConsent};
use crate::context::{AppContext, DATA_DIR_ENV};
use crate::error::AppError;
use crate::sync::Sources;

/// Số lần tối đa xem lại văn bản đồng ý khi server báo `consent_outdated`.
const MAX_CONSENT_ATTEMPTS: u32 = 3;
/// Độ dài tối đa của tên hiển thị (contract: `maxLength: 100`).
const MAX_NAME_CHARS: usize = 100;
/// Số lần hỏi lại tên khi nhập sai.
const MAX_NAME_PROMPTS: u32 = 3;

#[derive(Debug, Args)]
pub struct JoinArgs {
    /// Link mời, ví dụ https://teamlens.congty.com/i/<mã>
    pub invite_url: Option<String>,

    /// Tên hiển thị trên dashboard
    #[arg(long, value_name = "TÊN")]
    pub name: Option<String>,

    /// Không hỏi lại khi văn bản đồng ý vừa đổi
    #[arg(long, hide = true)]
    pub yes: bool,

    /// Gửi cả session cũ trên máy
    #[arg(long, conflicts_with = "no_backfill")]
    pub backfill: bool,

    /// Chỉ gửi session từ bây giờ
    #[arg(long)]
    pub no_backfill: bool,
}

/// Kết quả tham gia, trả ra để test kiểm tra.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinOutcome {
    pub server_url: String,
    pub user_id: String,
    pub device_id: String,
    pub project_slug: String,
    /// `true` khi server cấp token mới (máy mới, `201`).
    pub new_token: bool,
    pub backfill: bool,
    pub text_version: String,
}

/// Link mời đã tách.
#[derive(Clone, PartialEq, Eq)]
pub struct InviteLink {
    pub server_url: String,
    pub code: String,
}

// Mã mời là bí mật: không in ra log debug.
impl std::fmt::Debug for InviteLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InviteLink")
            .field("server_url", &self.server_url)
            .field("code", &"<ẩn>")
            .finish()
    }
}

/// Tách `https://<server>[/đường-dẫn]/i/<mã>[/][?...][#...]` thành địa chỉ server và mã.
pub fn parse_invite_url(input: &str) -> Result<InviteLink, AppError> {
    let invalid = || {
        AppError::user(
            format!("Link mời không đúng định dạng: \"{}\"", input.trim()),
            "Chép nguyên link leader gửi, dạng https://<server>/i/<mã>, rồi chạy `tl join <link>`.",
        )
    };
    let trimmed = input.trim();
    let without_extra = trimmed
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim_end_matches('/');
    let (base, code) = without_extra.rsplit_once("/i/").ok_or_else(invalid)?;
    let valid_code = (10..=100).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !valid_code {
        return Err(invalid());
    }
    let server_url = normalize_server_url(base).map_err(|_| invalid())?;
    Ok(InviteLink {
        server_url,
        code: code.to_owned(),
    })
}

pub async fn run(ctx: &AppContext, args: JoinArgs, out: &mut dyn Write) -> Result<(), AppError> {
    let sources = Sources::from_env();
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    run_with(ctx, args, &sources.adapter_refs(), &mut input, out).await?;
    setup_background(out);
    Ok(())
}

/// Kết quả đăng ký chạy nền sau khi tham gia.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundSetup {
    /// Đã đăng ký và khởi động daemon ngay.
    Started,
    /// Đã đăng ký nhưng chưa khởi động ngay được (sẽ chạy ở lần đăng nhập sau).
    Registered,
    /// Không đăng ký được.
    Failed,
}

/// Đăng ký daemon chạy nền cho `tl.exe` đang chạy. Dùng thư mục dữ liệu riêng (`TL_DATA_DIR`)
/// thì bỏ qua: task chạy với thư mục dữ liệu mặc định nên sẽ không khớp.
fn setup_background(out: &mut dyn Write) {
    if std::env::var_os(DATA_DIR_ENV).is_some_and(|v| !v.is_empty()) {
        say(out, "Không đăng ký chạy nền vì đang dùng TL_DATA_DIR.");
        say(out, "Chạy tay: `tl daemon`.");
        return;
    }
    match std::env::current_exe() {
        Ok(exe) => {
            register_background(tl_platform::current().as_ref(), &exe, out);
        }
        Err(e) => {
            say(
                out,
                &format!("Chưa đăng ký chạy nền vì không tìm thấy tl.exe ({e})."),
            );
            say(out, "Gửi tay: `tl sync`.");
        }
    }
}

/// Đăng ký rồi khởi động daemon nền; không bao giờ làm lệnh `join` thất bại.
pub fn register_background(
    platform: &dyn Platform,
    exe: &Path,
    out: &mut dyn Write,
) -> BackgroundSetup {
    if let Err(e) = platform.register_autostart(exe) {
        tracing::debug!(error = ?e, "đăng ký chạy nền thất bại");
        say(out, &format!("Chưa đăng ký được chạy nền ({e})."));
        say(out, "Gửi tay: `tl sync`.");
        return BackgroundSetup::Failed;
    }
    match platform.start_autostart() {
        Ok(()) => {
            say(out, "Đã bật chạy nền.");
            say(out, "tl tự chạy mỗi khi bạn đăng nhập Windows.");
            BackgroundSetup::Started
        }
        Err(e) => {
            tracing::debug!(error = ?e, "chưa khởi động ngay được daemon nền");
            say(
                out,
                &format!("Đã bật chạy nền nhưng chưa khởi động được ({e})."),
            );
            say(out, "Chạy ngay: `tl daemon`, hoặc đăng nhập lại Windows.");
            BackgroundSetup::Registered
        }
    }
}

/// Như [`run`] nhưng nhận adapter (để đếm session cũ) và nguồn nhập (để test).
pub async fn run_with(
    ctx: &AppContext,
    args: JoinArgs,
    adapters: &[&dyn Adapter],
    input: &mut dyn BufRead,
    out: &mut dyn Write,
) -> Result<JoinOutcome, AppError> {
    let Some(url) = args.invite_url.as_deref() else {
        return Err(AppError::user(
            "Thiếu link mời.",
            "Chạy `tl join https://<server>/i/<mã>` với link leader gửi.",
        ));
    };
    let link = parse_invite_url(url)?;
    let server_url = link.server_url.clone();
    let public = ApiClient::new(&server_url, None)?;

    // Máy đã tham gia server này: dùng lại token nếu còn hiệu lực (server chỉ thêm project).
    let existing = existing_account(ctx, &server_url).await?;

    let mut name: Option<String> = existing.as_ref().map(|e| e.name.clone());
    let mut backfill: Option<bool> = if args.backfill {
        Some(true)
    } else if args.no_backfill {
        Some(false)
    } else {
        None
    };

    let mut attempt = 0;
    let (preview, result) = loop {
        attempt += 1;
        let preview = public
            .preview_invite(&link.code)
            .await
            .map_err(invite_error)?;
        show_preview(out, &preview);

        if let Some(e) = &existing {
            say(
                out,
                &format!("Máy này đã tham gia {server_url} với tên \"{}\".", e.name),
            );
        }
        let chosen_name = match &name {
            Some(n) => n.clone(),
            None => {
                let n = match args.name.as_deref() {
                    Some(n) => validate_name(n)?,
                    None => ask_name(input, out)?,
                };
                name = Some(n.clone());
                n
            }
        };
        let chosen_backfill = match backfill {
            Some(b) => b,
            None => {
                let b = ask_backfill(input, out, adapters, true)?;
                backfill = Some(b);
                b
            }
        };
        // Lần đầu: xem văn bản, nhập tên, chọn backfill là đồng ý. Văn bản đổi giữa chừng thì hỏi lại.
        if attempt > 1 && !args.yes && !ask_accept_new(input, out)? {
            return Err(AppError::user(
                "Đã hủy tham gia. Không gửi gì.",
                "Tham gia lại: `tl join <link mời>`.",
            ));
        }

        let body = JoinRequest {
            code: link.code.clone(),
            name: chosen_name,
            device_name: super::device_name(),
            os: super::OS_NAME.to_owned(),
            cli_version: crate::CLI_VERSION.to_owned(),
            consent: JoinConsent {
                text_version: preview.consent.version.clone(),
                backfill: chosen_backfill,
            },
        };
        let client = match &existing {
            Some(e) => ApiClient::new(&server_url, Some(e.token.clone()))?,
            None => public.clone(),
        };
        match client.join(&body).await {
            Ok(result) => break (preview, result),
            Err(e) if e.code() == Some(&ApiErrorCode::ConsentOutdated) => {
                if attempt >= MAX_CONSENT_ATTEMPTS {
                    return Err(AppError::user(
                        "Văn bản đồng ý trên server liên tục thay đổi.",
                        "Đợi vài phút rồi chạy lại `tl join <link mời>`.",
                    ));
                }
                say(out, "\nVăn bản đồng ý vừa thay đổi.");
            }
            Err(e) => return Err(invite_error(e)),
        }
    };

    let new_token = match (&result.access_token, &existing) {
        (Some(token), _) => {
            ctx.credentials.set_token(&server_url, token)?;
            true
        }
        (None, Some(_)) => false,
        (None, None) => {
            return Err(AppError::Api(ApiError::InvalidResponse {
                status: 200,
                detail: "server không trả token cho máy mới".into(),
            }))
        }
    };

    let backfill = backfill.unwrap_or(false);
    let mut config = ctx.load_config()?;
    config.server_url = Some(server_url.clone());
    consent::record(
        &mut config,
        &server_url,
        ProjectConsent {
            project_id: result.project.id.clone(),
            project_slug: result.project.slug.clone(),
            project_name: result.project.name.clone(),
            text_version: preview.consent.version.clone(),
            backfill,
            accepted_at: Utc::now(),
        },
    );
    ctx.save_config(&config)?;

    print_done(
        out,
        &server_url,
        &result,
        name.as_deref().unwrap_or(""),
        backfill,
    );

    Ok(JoinOutcome {
        server_url,
        user_id: result.user_id,
        device_id: result.device_id,
        project_slug: result.project.slug,
        new_token,
        backfill,
        text_version: preview.consent.version,
    })
}

/// Tài khoản đã có trên máy cho server này.
struct Existing {
    token: String,
    name: String,
}

/// Token đã lưu cho server và còn hiệu lực (`whoami` thành công). Token bị thu hồi thì
/// coi như máy mới; lỗi khác (mạng...) thì dừng để không tạo user trùng.
async fn existing_account(
    ctx: &AppContext,
    server_url: &str,
) -> Result<Option<Existing>, AppError> {
    let Some(token) = ctx.credentials.get_token(server_url)? else {
        return Ok(None);
    };
    let client = ApiClient::new(server_url, Some(token.clone()))?;
    match client.whoami().await {
        Ok(me) => Ok(Some(Existing {
            token,
            name: me.user.name,
        })),
        Err(e)
            if matches!(
                e.code(),
                Some(ApiErrorCode::InvalidToken | ApiErrorCode::Unauthenticated)
            ) || matches!(e, ApiError::Api { status: 401, .. }) =>
        {
            tracing::debug!("token cũ không còn hiệu lực, tham gia như máy mới");
            Ok(None)
        }
        Err(e) => Err(AppError::Api(e)),
    }
}

/// Lỗi của hai endpoint mời → thông báo tiếng Việt kèm gợi ý.
fn invite_error(e: ApiError) -> AppError {
    let new_link = "Xin leader một link mời mới rồi chạy lại `tl join <link mới>`.";
    let Some(code) = e.code() else {
        return AppError::Api(e);
    };
    match code {
        ApiErrorCode::InviteNotFound | ApiErrorCode::NotFound => {
            AppError::user("Không tìm thấy link mời này.", new_link)
        }
        ApiErrorCode::InviteExpired => AppError::user("Link mời đã hết hạn.", new_link),
        ApiErrorCode::InviteUsedUp => AppError::user("Link mời đã hết lượt dùng.", new_link),
        ApiErrorCode::InviteRevoked => AppError::user("Link mời đã bị leader thu hồi.", new_link),
        ApiErrorCode::RateLimited => AppError::user(
            "Server đang giới hạn số lần thử từ máy này.",
            "Đợi vài phút rồi chạy lại `tl join <link mời>`.",
        ),
        ApiErrorCode::Other(_) if matches!(e, ApiError::Api { status: 410, .. }) => {
            AppError::user("Link mời không còn dùng được.", new_link)
        }
        _ => AppError::Api(e),
    }
}

fn show_preview(out: &mut dyn Write, p: &InvitePreview) {
    let _ = writeln!(out);
    let _ = writeln!(out, "══ Tham gia TeamLens ══");
    let _ = writeln!(out, "Server:   {}", p.server_url);
    let _ = writeln!(out, "Project:  {} ({})", p.project.name, p.project.slug);
    let _ = writeln!(out, "Hết hạn:  {}", format_time(&p.expires_at));
    let _ = writeln!(out);
    let _ = writeln!(out, "Repo được gửi:");
    if p.repo_patterns.is_empty() {
        let _ = writeln!(out, "  (chưa có repo nào)");
    }
    for pattern in &p.repo_patterns {
        let _ = writeln!(out, "  - {pattern}");
    }
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "── Văn bản đồng ý (phiên bản {}) ──",
        p.consent.version
    );
    for line in p.consent.text.lines() {
        let _ = writeln!(out, "{}", line.trim_end());
    }
    let _ = writeln!(out, "──");
    let _ = writeln!(out);
    let _ = out.flush();
}

/// Đổi chuỗi thời gian RFC 3339 sang giờ máy cho dễ đọc; không parse được thì giữ nguyên.
pub(super) fn format_time(s: &str) -> String {
    DateTime::parse_from_rfc3339(s)
        .map(|t| t.with_timezone(&Local).format("%d/%m/%Y %H:%M").to_string())
        .unwrap_or_else(|_| s.to_owned())
}

/// Tên user Windows (gợi ý tên hiển thị).
fn default_display_name() -> Option<String> {
    ["USERNAME", "USER"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .map(|v| v.trim().to_owned())
        .find(|v| !v.is_empty())
}

fn validate_name(raw: &str) -> Result<String, AppError> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::user(
            "Tên hiển thị phải có từ 1 tới 100 ký tự.",
            "Nhập lại tên, ví dụ `--name \"Nguyễn Văn A\"`.",
        ));
    }
    Ok(name.to_owned())
}

/// Đọc một dòng; hết input (EOF) → `None`.
pub(super) fn read_line(input: &mut dyn BufRead) -> Result<Option<String>, AppError> {
    let mut line = String::new();
    match input.read_line(&mut line) {
        Ok(0) => Ok(None),
        Ok(_) => Ok(Some(line.trim().to_owned())),
        Err(e) => Err(AppError::user(
            format!("Không đọc được câu trả lời từ bàn phím: {e}"),
            NO_INPUT_HINT,
        )),
    }
}

/// Gợi ý khi không đọc được câu trả lời (dùng chung cho `tl join` và `tl consent`).
const NO_INPUT_HINT: &str =
    "Chạy lại trong cửa sổ terminal, hoặc trả lời bằng cờ `--yes`, `--backfill`, `--no-backfill`.";

pub(super) fn no_input() -> AppError {
    AppError::user("Không đọc được câu trả lời từ bàn phím.", NO_INPUT_HINT)
}

fn ask_name(input: &mut dyn BufRead, out: &mut dyn Write) -> Result<String, AppError> {
    let suggestion = default_display_name();
    for _ in 0..MAX_NAME_PROMPTS {
        match &suggestion {
            Some(s) => prompt(out, &format!("Tên hiển thị (Enter để dùng \"{s}\"): ")),
            None => prompt(out, "Tên hiển thị: "),
        }
        let answer = read_line(input)?.ok_or_else(no_input)?;
        let raw = if answer.is_empty() {
            suggestion.clone().unwrap_or_default()
        } else {
            answer
        };
        match validate_name(&raw) {
            Ok(name) => return Ok(name),
            Err(e) => say(out, &e.to_string()),
        }
    }
    Err(AppError::user(
        "Tên hiển thị không hợp lệ.",
        "Chạy lại `tl join <link mời>` hoặc dùng `--name \"Tên của bạn\"`.",
    ))
}

/// Session cũ trên máy: số file log và khoảng ngày (theo thời điểm sửa file). Chỉ đọc
/// danh sách file, không đọc nội dung.
fn local_history(adapters: &[&dyn Adapter]) -> (usize, Option<(SystemTime, SystemTime)>) {
    let mut count = 0;
    let mut range: Option<(SystemTime, SystemTime)> = None;
    for adapter in adapters {
        for file in adapter.discover() {
            count += 1;
            if let Some(m) = file.modified {
                range = Some(match range {
                    None => (m, m),
                    Some((lo, hi)) => (lo.min(m), hi.max(m)),
                });
            }
        }
    }
    (count, range)
}

pub(super) fn ask_backfill(
    input: &mut dyn BufRead,
    out: &mut dyn Write,
    adapters: &[&dyn Adapter],
    default_yes: bool,
) -> Result<bool, AppError> {
    let (count, range) = local_history(adapters);
    if count == 0 {
        return Ok(false);
    }
    let day = |t: SystemTime| DateTime::<Local>::from(t).format("%d/%m/%Y").to_string();
    let span = range
        .map(|(lo, hi)| format!(", từ {} tới {}", day(lo), day(hi)))
        .unwrap_or_default();
    say(
        out,
        &format!("Máy này có {count} file session cũ{span}, tính cả repo ngoài project."),
    );
    if default_yes {
        prompt(
            out,
            "Gửi cả session cũ thuộc các repo trên? (Enter: có, no: không): ",
        );
    } else {
        prompt(
            out,
            "Gửi cả session cũ thuộc các repo trên? (c: có, Enter: không): ",
        );
    }
    let answer = read_line(input)?.ok_or_else(no_input)?;
    Ok(match answer.to_lowercase().as_str() {
        "c" | "có" | "co" | "y" | "yes" => true,
        "" => default_yes,
        // Gõ gì khác thì coi là không, cho an toàn.
        _ => false,
    })
}

/// Văn bản đồng ý đổi trong lúc tham gia: hỏi lại, Enter là đồng ý bản mới.
fn ask_accept_new(input: &mut dyn BufRead, out: &mut dyn Write) -> Result<bool, AppError> {
    prompt(out, "Đồng ý bản mới? (Enter: có, no: hủy): ");
    let answer = read_line(input)?.ok_or_else(no_input)?;
    Ok(matches!(
        answer.to_lowercase().as_str(),
        "" | "c" | "có" | "co" | "y" | "yes"
    ))
}

/// Hỏi một câu và chỉ coi là đồng ý khi người dùng gõ đúng `yes` (không phân biệt hoa thường).
pub(super) fn ask_confirmation(
    input: &mut dyn BufRead,
    out: &mut dyn Write,
    question: &str,
) -> Result<bool, AppError> {
    prompt(out, question);
    Ok(read_line(input)?.is_some_and(|a| a.eq_ignore_ascii_case("yes")))
}

fn print_done(
    out: &mut dyn Write,
    server_url: &str,
    result: &JoinResult,
    name: &str,
    backfill: bool,
) {
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "Đã tham gia project {} trên {server_url} với tên \"{name}\".",
        result.project.name
    );
    let _ = writeln!(
        out,
        "{}",
        if backfill {
            "Sẽ gửi cả session cũ thuộc các repo của project."
        } else {
            "Chỉ gửi session từ bây giờ."
        }
    );
    let _ = writeln!(out, "Gửi ngay: `tl sync`.");
    let _ = writeln!(out, "Mở dashboard: `tl open`.");
    let _ = out.flush();
}

pub(super) fn prompt(out: &mut dyn Write, text: &str) {
    let _ = write!(out, "{text}");
    let _ = out.flush();
}

pub(super) fn say(out: &mut dyn Write, line: &str) {
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tach_link_moi() {
        let l = parse_invite_url(" https://tl.congty.com/i/AbcDEF_123-xyz ").unwrap();
        assert_eq!(l.server_url, "https://tl.congty.com");
        assert_eq!(l.code, "AbcDEF_123-xyz");

        let l = parse_invite_url("http://localhost:3121/i/AbcDEF_123-xyz/?utm=1#x").unwrap();
        assert_eq!(l.server_url, "http://localhost:3121");
        assert_eq!(l.code, "AbcDEF_123-xyz");

        // Server đặt dưới đường dẫn con.
        let l = parse_invite_url("https://congty.com/teamlens/i/AbcDEF_123-xyz").unwrap();
        assert_eq!(l.server_url, "https://congty.com/teamlens");
    }

    #[test]
    fn link_sai_dinh_dang() {
        for bad in [
            "",
            "tl.congty.com/i/AbcDEF_123-xyz",
            "https://tl.congty.com/AbcDEF_123-xyz",
            "https://tl.congty.com/i/ngan",
            "https://tl.congty.com/i/co dau cach",
            "https://tl.congty.com/i/AbcDEF_123/xyz",
            "https:///i/AbcDEF_123-xyz",
        ] {
            let e = parse_invite_url(bad).unwrap_err();
            assert!(e.to_string().contains("Link mời"), "{bad}: {e}");
            assert!(e.hint().unwrap().contains("/i/"));
        }
    }

    #[test]
    fn debug_khong_lo_ma_moi() {
        let l = parse_invite_url("https://tl.congty.com/i/AbcDEF_123-xyz").unwrap();
        assert!(!format!("{l:?}").contains("AbcDEF"));
    }

    /// Platform giả: ghi lại lời gọi, trả lỗi theo cấu hình.
    #[derive(Default)]
    struct FakePlatform {
        fail_register: bool,
        fail_start: bool,
        calls: std::sync::Mutex<Vec<String>>,
    }

    impl Platform for FakePlatform {
        fn data_dir(&self) -> Result<std::path::PathBuf, tl_platform::PlatformError> {
            unreachable!("join không dùng thư mục dữ liệu của platform")
        }
        fn credential_store(&self) -> Box<dyn tl_platform::CredentialStore> {
            unreachable!("join không dùng credential store của platform")
        }
        fn acquire_single_instance(
            &self,
            _name: &str,
        ) -> Result<Option<tl_platform::InstanceGuard>, tl_platform::PlatformError> {
            unreachable!("join không giữ mutex")
        }
        fn register_autostart(&self, exe: &Path) -> Result<(), tl_platform::PlatformError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("register {}", exe.display()));
            if self.fail_register {
                return Err(tl_platform::PlatformError::Os("bị chặn".into()));
            }
            Ok(())
        }
        fn unregister_autostart(&self) -> Result<(), tl_platform::PlatformError> {
            unreachable!("join không gỡ task")
        }
        fn autostart_registered(&self) -> Result<bool, tl_platform::PlatformError> {
            unreachable!("join không hỏi trạng thái task")
        }
        fn start_autostart(&self) -> Result<(), tl_platform::PlatformError> {
            self.calls.lock().unwrap().push("start".into());
            if self.fail_start {
                return Err(tl_platform::PlatformError::Os("không chạy được".into()));
            }
            Ok(())
        }
    }

    #[test]
    fn dang_ky_chay_nen_thanh_cong_thi_khoi_dong_ngay() {
        let platform = FakePlatform::default();
        let mut out = Vec::new();
        let outcome = register_background(&platform, Path::new(r"C:\tl\tl.exe"), &mut out);
        assert_eq!(outcome, BackgroundSetup::Started);
        assert_eq!(
            *platform.calls.lock().unwrap(),
            vec![r"register C:\tl\tl.exe".to_owned(), "start".to_owned()]
        );
        let printed = String::from_utf8(out).unwrap();
        assert!(printed.contains("Đã bật chạy nền."), "{printed}");
        assert!(
            printed.contains("mỗi khi bạn đăng nhập Windows"),
            "{printed}"
        );
    }

    #[test]
    fn dang_ky_duoc_nhung_chua_khoi_dong_duoc_thi_bao_chay_o_lan_dang_nhap_sau() {
        let platform = FakePlatform {
            fail_start: true,
            ..Default::default()
        };
        let mut out = Vec::new();
        let outcome = register_background(&platform, Path::new("tl.exe"), &mut out);
        assert_eq!(outcome, BackgroundSetup::Registered);
        let printed = String::from_utf8(out).unwrap();
        assert!(printed.contains("chưa khởi động được"), "{printed}");
        assert!(printed.contains("đăng nhập lại Windows"), "{printed}");
    }

    #[test]
    fn dang_ky_loi_thi_chi_canh_bao_va_khong_khoi_dong() {
        let platform = FakePlatform {
            fail_register: true,
            ..Default::default()
        };
        let mut out = Vec::new();
        let outcome = register_background(&platform, Path::new("tl.exe"), &mut out);
        assert_eq!(outcome, BackgroundSetup::Failed);
        assert_eq!(*platform.calls.lock().unwrap(), vec!["register tl.exe"]);
        let printed = String::from_utf8(out).unwrap();
        assert!(printed.contains("Chưa đăng ký được chạy nền"), "{printed}");
        assert!(printed.contains("tl sync"), "{printed}");
    }

    #[test]
    fn kiem_tra_ten() {
        assert_eq!(validate_name("  An  ").unwrap(), "An");
        assert!(validate_name("   ").is_err());
        assert!(validate_name(&"a".repeat(101)).is_err());
        assert!(validate_name(&"ă".repeat(100)).is_ok());
    }
}
