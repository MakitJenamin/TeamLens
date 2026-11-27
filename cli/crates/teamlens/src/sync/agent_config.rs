//! Cấu hình từ server (`GET /agent/v1/config`, task M2.2): tải mỗi lần `tl sync`/`tl preview`,
//! cache bản gần nhất ở `<thư mục dữ liệu>/agent_config.json` để dùng khi mất mạng, và các
//! chốt dừng gửi (văn bản đồng ý đổi phiên bản, CLI cũ hơn `min_cli_version`).

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tl_core::scope::RepoPatterns;

use crate::api_client::{AgentConfig, ApiClient, ApiError};
use crate::config::Config;
use crate::consent;
use crate::context::AppContext;
use crate::error::AppError;
use crate::pipeline::prepare::PrepareOptions;

/// Tên file cache trong thư mục dữ liệu (cạnh `config.toml`).
pub const CACHE_FILE_NAME: &str = "agent_config.json";

/// Nội dung file cache: kèm server để không dùng nhầm cache của server khác.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedAgentConfig {
    pub server_url: String,
    pub fetched_at: DateTime<Utc>,
    pub config: AgentConfig,
}

/// Config lấy từ đâu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigSource {
    /// Vừa tải từ server.
    Server,
    /// Mất mạng, dùng bản cache tải lúc `fetched_at`.
    Cache { fetched_at: DateTime<Utc> },
}

/// Config đang dùng và nguồn của nó.
#[derive(Debug, Clone)]
pub struct LoadedConfig {
    pub config: AgentConfig,
    pub source: ConfigSource,
}

/// Đường dẫn file cache (cùng thư mục với `config.toml`).
pub fn cache_path(ctx: &AppContext) -> PathBuf {
    ctx.config_path
        .parent()
        .map(|dir| dir.join(CACHE_FILE_NAME))
        .unwrap_or_else(|| PathBuf::from(CACHE_FILE_NAME))
}

/// Đọc cache của `server_url`. Không có, hỏng hoặc của server khác → `None`.
pub fn read_cache(path: &Path, server_url: &str) -> Option<CachedAgentConfig> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<CachedAgentConfig>(&text) {
        Ok(cached) if cached.server_url == server_url => Some(cached),
        Ok(_) => None,
        Err(e) => {
            tracing::debug!(error = %e, "cache config hỏng, bỏ qua");
            None
        }
    }
}

/// Ghi cache (ghi file tạm rồi đổi tên). Lỗi ghi chỉ log, không chặn lệnh.
pub fn write_cache(path: &Path, server_url: &str, config: &AgentConfig) {
    let cached = CachedAgentConfig {
        server_url: server_url.to_owned(),
        fetched_at: Utc::now(),
        config: config.clone(),
    };
    let result = (|| -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&cached)?)?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        tracing::warn!(error = %e, path = %path.display(), "không ghi được cache config");
    }
}

/// Tải config từ server; ghi cache khi thành công. Không tới được server (lỗi mạng, hoặc HTTP 5xx
/// như proxy báo API đang tắt) → dùng cache (nếu có), lỗi khác
/// (401, server trả sai...) → trả lỗi.
pub async fn load(
    ctx: &AppContext,
    client: &ApiClient,
    server_url: &str,
) -> Result<LoadedConfig, ApiError> {
    let path = cache_path(ctx);
    match client.get_config().await {
        Ok(config) => {
            write_cache(&path, server_url, &config);
            Ok(LoadedConfig {
                config,
                source: ConfigSource::Server,
            })
        }
        Err(e) if unreachable(&e) => match read_cache(&path, server_url) {
            Some(cached) => {
                tracing::info!(fetched_at = %cached.fetched_at, "mất mạng, dùng config đã cache");
                Ok(LoadedConfig {
                    config: cached.config,
                    source: ConfigSource::Cache {
                        fetched_at: cached.fetched_at,
                    },
                })
            }
            None => Err(e),
        },
        Err(e) => Err(e),
    }
}

/// Lỗi kiểu "không tới được server": lỗi mạng hoặc HTTP 5xx (proxy/Caddy trả 502/503 khi
/// API tắt). Lỗi 4xx (token sai...) không tính, để người dùng thấy và sửa.
fn unreachable(e: &ApiError) -> bool {
    match e {
        ApiError::Network { .. } => true,
        ApiError::Api { status, .. } | ApiError::InvalidResponse { status, .. } => *status >= 500,
        ApiError::Build(_) => false,
    }
}

/// Tập repo pattern cho bước lọc phạm vi, theo thứ tự server trả. Pattern lỗi bị bỏ qua.
pub fn repo_patterns(config: &AgentConfig) -> RepoPatterns {
    let mut patterns = RepoPatterns::new();
    for p in &config.repo_patterns {
        if !patterns.add(p.project_id.clone(), &p.pattern) {
            tracing::debug!(project = %p.project_id, pattern = %p.pattern, "bỏ qua repo pattern không hợp lệ");
        }
    }
    patterns
}

/// Áp config vào tùy chọn xử lý: ngưỡng cắt và pattern che secret của server.
pub fn apply_to_prepare(base: &PrepareOptions, config: &AgentConfig) -> PrepareOptions {
    PrepareOptions {
        limits: config.truncation.into(),
        server_redaction_patterns: config.redaction_patterns.clone(),
        ..base.clone()
    }
}

/// Lý do không được gửi theo config của server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendBlock {
    /// Máy chưa đồng ý bản văn bản hiện hành (`accepted`: các phiên bản máy đã đồng ý).
    ConsentOutdated {
        required: String,
        accepted: Vec<String>,
    },
    /// Bản `tl` đang chạy cũ hơn `min_cli_version`.
    CliTooOld { current: String, required: String },
}

impl SendBlock {
    /// Lỗi tiếng Việt cho người dùng (exit code 1).
    pub fn to_error(&self) -> AppError {
        match self {
            SendBlock::ConsentOutdated { required, accepted } => AppError::user(
                format!(
                    "Văn bản đồng ý của TeamLens đã đổi (bản {required}{}), nên chưa gửi gì.",
                    if accepted.is_empty() {
                        String::new()
                    } else {
                        format!(", máy này mới đồng ý bản {}", accepted.join(", "))
                    }
                ),
                "Chạy lại `tl join <link mời>` (link do leader gửi) để đọc và đồng ý bản mới.",
            ),
            SendBlock::CliTooOld { current, required } => AppError::user(
                format!(
                    "Bản tl {current} đã cũ, server yêu cầu tối thiểu bản {required}, nên chưa gửi gì."
                ),
                format!("Chạy `tl update` để cập nhật tl (cần bản {required} trở lên) rồi chạy lại `tl sync`."),
            ),
        }
    }
}

/// Kiểm tra máy có được gửi theo config không. Đồng ý bản hiện hành ở **bất kỳ** project nào
/// là đủ (giống server: ingest nhận khi thiết bị có một bản đồng ý đúng phiên bản).
/// Chưa có bản đồng ý nào cho server hiện tại thì để `consent_gate` xử lý, ở đây không chặn.
pub fn check_send(
    local: &Config,
    config: &AgentConfig,
    cli_version: &str,
) -> Result<(), SendBlock> {
    if is_older(cli_version, &config.min_cli_version) {
        return Err(SendBlock::CliTooOld {
            current: cli_version.to_owned(),
            required: config.min_cli_version.clone(),
        });
    }
    if let Some(state) = consent::current(local) {
        let ok = state
            .projects
            .iter()
            .any(|p| p.text_version == config.consent_text_version);
        if !ok {
            let mut accepted: Vec<String> = state
                .projects
                .iter()
                .map(|p| p.text_version.clone())
                .collect();
            accepted.sort();
            accepted.dedup();
            return Err(SendBlock::ConsentOutdated {
                required: config.consent_text_version.clone(),
                accepted,
            });
        }
    }
    Ok(())
}

/// `x.y.z` → bộ số; bỏ tiền tố `v` và hậu tố `-pre`/`+build`. Sai dạng → `None`.
fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let core = v.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let major = parts.next()??;
    let minor = parts.next().unwrap_or(Some(0))?;
    let patch = parts.next().unwrap_or(Some(0))?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// `current < required`? `required` sai dạng thì không chặn (chỉ log).
pub fn is_older(current: &str, required: &str) -> bool {
    match (parse_version(current), parse_version(required)) {
        (Some(c), Some(r)) => c < r,
        _ => {
            tracing::warn!(current, required, "không so được phiên bản tl");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_client::{AgentRepoPattern, AgentTruncation};
    use crate::consent::ProjectConsent;

    fn agent_config(consent_version: &str, min: &str) -> AgentConfig {
        AgentConfig {
            repo_patterns: vec![AgentRepoPattern {
                project_id: "p1".into(),
                pattern: "github.com/acme/*".into(),
            }],
            redaction_patterns: vec![],
            truncation: AgentTruncation::default(),
            consent_text_version: consent_version.into(),
            min_cli_version: min.into(),
        }
    }

    fn local(versions: &[&str]) -> Config {
        let mut cfg = Config {
            server_url: Some("http://a".into()),
            ..Default::default()
        };
        for (i, v) in versions.iter().enumerate() {
            consent::record(
                &mut cfg,
                "http://a",
                ProjectConsent {
                    project_id: format!("p{i}"),
                    project_slug: format!("p{i}"),
                    project_name: format!("p{i}"),
                    text_version: (*v).into(),
                    backfill: true,
                    accepted_at: Utc::now(),
                },
            );
        }
        cfg
    }

    #[test]
    fn so_sanh_phien_ban() {
        assert!(is_older("0.1.0", "0.2.0"));
        assert!(is_older("0.9.9", "1.0.0"));
        assert!(is_older("1.2.3", "1.10.0"));
        assert!(!is_older("0.1.0", "0.1.0"));
        assert!(!is_older("0.2.0", "0.1.9"));
        assert!(!is_older("v1.0.0-beta", "1.0.0"), "bỏ hậu tố pre-release");
        assert!(!is_older("0.1.0", "rác"), "sai dạng thì không chặn");
        assert!(is_older("0.1.0", "1"), "thiếu phần thì coi là 0");
    }

    #[test]
    fn chan_khi_cli_cu() {
        let err = check_send(&local(&["v1"]), &agent_config("v1", "9.9.9"), "0.1.0").unwrap_err();
        assert!(matches!(err, SendBlock::CliTooOld { .. }));
        let e = err.to_error();
        assert!(e.to_string().contains("9.9.9"), "{e}");
        assert!(e.hint().unwrap().contains("tl update"));
    }

    #[test]
    fn chan_khi_lech_phien_ban_dong_y() {
        let err = check_send(&local(&["v1"]), &agent_config("v2", "0.1.0"), "0.1.0").unwrap_err();
        assert_eq!(
            err,
            SendBlock::ConsentOutdated {
                required: "v2".into(),
                accepted: vec!["v1".into()]
            }
        );
        assert!(err.to_error().hint().unwrap().contains("tl join"));
        // Một project đã đồng ý bản mới là đủ.
        assert!(check_send(&local(&["v1", "v2"]), &agent_config("v2", "0.1.0"), "0.1.0").is_ok());
        // Chưa đồng ý gì: để consent_gate lo.
        assert!(check_send(&local(&[]), &agent_config("v2", "0.1.0"), "0.1.0").is_ok());
    }

    #[test]
    fn cache_theo_server() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CACHE_FILE_NAME);
        assert!(read_cache(&path, "http://a").is_none());
        let cfg = agent_config("v1", "0.1.0");
        write_cache(&path, "http://a", &cfg);
        assert_eq!(read_cache(&path, "http://a").unwrap().config, cfg);
        assert!(
            read_cache(&path, "http://b").is_none(),
            "cache của server khác"
        );
        std::fs::write(&path, "{hỏng").unwrap();
        assert!(read_cache(&path, "http://a").is_none());
    }

    #[test]
    fn ap_nguong_cat_va_pattern() {
        let mut cfg = agent_config("v1", "0.1.0");
        cfg.truncation.tool_input_bytes = 10;
        cfg.redaction_patterns = vec![crate::api_client::AgentRedactionPattern {
            id: "acme".into(),
            regex: "acme_[a-z]+".into(),
        }];
        let opts = apply_to_prepare(&PrepareOptions::default(), &cfg);
        assert_eq!(opts.limits.tool_input_max, 10);
        assert_eq!(opts.limits.output_head, 2048);
        assert_eq!(opts.server_redaction_patterns.len(), 1);
    }

    #[test]
    fn json_snake_case_va_truncation_thieu_truong() {
        let cfg: AgentConfig = serde_json::from_str(
            r#"{"repo_patterns":[{"project_id":"p","pattern":"github.com/a/*"}],
                "redaction_patterns":[{"id":"x","regex":"y"}],
                "truncation":{"tool_input_bytes":100},
                "consent_text_version":"2026-11-27.2","min_cli_version":"0.1.0"}"#,
        )
        .unwrap();
        assert_eq!(cfg.truncation.tool_input_bytes, 100);
        assert_eq!(cfg.truncation.diff_bytes, 262_144);
        assert_eq!(repo_patterns(&cfg).patterns().len(), 1);
    }
}
