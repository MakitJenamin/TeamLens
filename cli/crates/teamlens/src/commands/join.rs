//! `tl join <link mời>` (tên gọi khác: `tl login <link mời>`) — lệnh duy nhất thành viên
//! cần chạy (SPEC 4.3, 7.1).
//!
//! 1. Tách địa chỉ server và mã mời từ link `https://<server>/i/<mã>`.
//! 2. `GET /agent/v1/invites/{code}` → màn hình đồng ý trong terminal: server, project,
//!    repo sẽ thu thập, văn bản đồng ý; hỏi tên hiển thị, hỏi backfill, bắt gõ `yes`.
//!    Từ chối thì thoát, không gọi `join`, không lưu gì.
//! 3. `POST /agent/v1/join` (kèm Bearer nếu máy đã có token còn hiệu lực cho server đó).
//!    `409 consent_outdated` → xem trước lại và hỏi lại.
//! 4. Lưu token (chỉ khi server trả token mới) vào Credential Manager, lưu server và bản
//!    đồng ý vào config.
//!
//! Đăng ký chạy nền bằng Task Scheduler là task M3.8, chưa làm ở đây.

use std::io::{BufRead, Write};
use std::time::SystemTime;

use chrono::{DateTime, Local, Utc};
use clap::Args;
use tl_adapters::Adapter;

use crate::api_client::{
    ApiClient, ApiError, ApiErrorCode, InvitePreview, JoinConsent, JoinRequest, JoinResult,
};
use crate::config::normalize_server_url;
use crate::consent::{self, ProjectConsent};
use crate::context::AppContext;
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
    /// Link mời leader gửi, ví dụ https://teamlens.congty.com/i/<mã>
    pub invite_url: Option<String>,

    /// Tên hiển thị trên dashboard (bỏ qua câu hỏi tên)
    #[arg(long, value_name = "TÊN")]
    pub name: Option<String>,

    /// Đồng ý luôn, không hỏi gõ `yes` (cho cài đặt tự động)
    #[arg(long)]
    pub yes: bool,

    /// Gửi cả lịch sử session cũ trên máy (bỏ qua câu hỏi backfill)
    #[arg(long, conflicts_with = "no_backfill")]
    pub backfill: bool,

    /// Chỉ gửi session từ bây giờ (bỏ qua câu hỏi backfill)
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
            "Link mời có dạng https://<server>/i/<mã>. Chép nguyên link leader gửi rồi chạy `tl join <link>`.",
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
    run_with(ctx, args, &sources.adapter_refs(), &mut input, out)
        .await
        .map(|_| ())
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
            "Chạy `tl join <link mời>` (hoặc `tl login <link mời>`) với link leader gửi, dạng https://<server>/i/<mã>.",
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
                &format!(
                    "Máy này đã tham gia {server_url} với tên \"{}\"; sẽ thêm vào project này.",
                    e.name
                ),
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
                let b = ask_backfill(input, out, adapters)?;
                backfill = Some(b);
                b
            }
        };
        if !args.yes && !ask_yes(input, out)? {
            say(
                out,
                "Bạn chưa đồng ý nên máy này chưa tham gia, không có gì được gửi đi.",
            );
            return Err(AppError::user(
                "Đã hủy tham gia.",
                "Khi sẵn sàng, chạy lại `tl join <link mời>` và gõ `yes` để đồng ý.",
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
                say(
                    out,
                    "\nVăn bản đồng ý trên server vừa thay đổi. Hãy đọc lại bản mới dưới đây.",
                );
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
            AppError::user("Link mời không đúng (không tìm thấy mã mời).", new_link)
        }
        ApiErrorCode::InviteExpired => AppError::user("Link mời đã hết hạn.", new_link),
        ApiErrorCode::InviteUsedUp => AppError::user("Link mời đã hết lượt dùng.", new_link),
        ApiErrorCode::InviteRevoked => AppError::user("Link mời đã bị leader thu hồi.", new_link),
        ApiErrorCode::RateLimited => AppError::user(
            "Server đang giới hạn số lần thử từ máy/mạng này.",
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
    let _ = writeln!(out, "Link hết hạn: {}", format_time(&p.expires_at));
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "Chỉ session AI agent trong các repo sau được gửi đi (session ở nơi khác không bao giờ rời máy):"
    );
    if p.repo_patterns.is_empty() {
        let _ = writeln!(
            out,
            "  (project chưa khai báo repo nào: chưa có gì được gửi)"
        );
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
fn format_time(s: &str) -> String {
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
fn read_line(input: &mut dyn BufRead) -> Result<Option<String>, AppError> {
    let mut line = String::new();
    match input.read_line(&mut line) {
        Ok(0) => Ok(None),
        Ok(_) => Ok(Some(line.trim().to_owned())),
        Err(e) => Err(AppError::user(
            format!("Không đọc được câu trả lời từ bàn phím: {e}"),
            "Chạy `tl join` trong cửa sổ terminal, hoặc dùng `--name`, `--yes`, `--backfill`/`--no-backfill`.",
        )),
    }
}

fn no_input() -> AppError {
    AppError::user(
        "Không có câu trả lời (không chạy trong terminal?). Chưa tham gia.",
        "Chạy `tl join` trong cửa sổ terminal, hoặc dùng `--name`, `--yes`, `--backfill`/`--no-backfill`.",
    )
}

fn ask_name(input: &mut dyn BufRead, out: &mut dyn Write) -> Result<String, AppError> {
    let suggestion = default_display_name();
    for _ in 0..MAX_NAME_PROMPTS {
        match &suggestion {
            Some(s) => prompt(
                out,
                &format!("Tên hiển thị để leader biết bạn là ai (Enter để dùng \"{s}\"): "),
            ),
            None => prompt(out, "Tên hiển thị để leader biết bạn là ai: "),
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
        "Chưa nhập được tên hiển thị hợp lệ.",
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

fn ask_backfill(
    input: &mut dyn BufRead,
    out: &mut dyn Write,
    adapters: &[&dyn Adapter],
) -> Result<bool, AppError> {
    let (count, range) = local_history(adapters);
    if count == 0 {
        say(
            out,
            "Máy này chưa có session cũ nào, bỏ qua câu hỏi gửi lịch sử.",
        );
        return Ok(false);
    }
    let day = |t: SystemTime| DateTime::<Local>::from(t).format("%d/%m/%Y").to_string();
    let span = range
        .map(|(lo, hi)| format!(", từ {} tới {}", day(lo), day(hi)))
        .unwrap_or_default();
    say(
        out,
        &format!(
            "Máy này có {count} file session cũ{span} (tính cả repo ngoài project; những session đó không bao giờ được gửi)."
        ),
    );
    prompt(
        out,
        "Gửi cả lịch sử session cũ thuộc các repo trên? [c/K] (Enter = không, chỉ gửi từ bây giờ): ",
    );
    let answer = read_line(input)?.ok_or_else(no_input)?;
    Ok(matches!(
        answer.to_lowercase().as_str(),
        "c" | "có" | "co" | "y" | "yes"
    ))
}

fn ask_yes(input: &mut dyn BufRead, out: &mut dyn Write) -> Result<bool, AppError> {
    prompt(
        out,
        "Gõ `yes` để đồng ý và tham gia (gõ gì khác hoặc Enter là từ chối): ",
    );
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
            "Sẽ gửi cả lịch sử session cũ thuộc các repo của project."
        } else {
            "Chỉ gửi session từ bây giờ (không gửi lịch sử cũ)."
        }
    );
    let _ = writeln!(out, "Chạy `tl sync` để gửi ngay; chạy nền sẽ có ở bản sau.");
    let _ = writeln!(out, "Xem dashboard: `tl open`.");
    let _ = out.flush();
}

fn prompt(out: &mut dyn Write, text: &str) {
    let _ = write!(out, "{text}");
    let _ = out.flush();
}

fn say(out: &mut dyn Write, line: &str) {
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

    #[test]
    fn kiem_tra_ten() {
        assert_eq!(validate_name("  An  ").unwrap(), "An");
        assert!(validate_name("   ").is_err());
        assert!(validate_name(&"a".repeat(101)).is_err());
        assert!(validate_name(&"ă".repeat(100)).is_ok());
    }
}
