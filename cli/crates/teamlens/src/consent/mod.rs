//! Trạng thái đồng ý cục bộ (SPEC 4.3).
//!
//! `tl join` ghi bản đồng ý vào `config.toml` (bảng `[consent]`) sau khi server nhận
//! `POST /agent/v1/join`: server nào, project nào, phiên bản văn bản, có backfill không,
//! đồng ý lúc nào. Pipeline gửi hỏi module này (qua `sync::consent_gate`) trước khi gửi:
//! - chưa đồng ý cho server hiện tại → không gửi gì;
//! - session thuộc project chưa đồng ý → không gửi;
//! - không backfill → bỏ session có hoạt động cuối trước thời điểm đồng ý.
//!
//! Server vẫn là chốt chặn cuối (ingest trả `403 consent_required`).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::config::Config;

/// Bản đồng ý của máy này với một server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsentState {
    /// Server đã đồng ý (đã chuẩn hóa như `Config::server_url`).
    pub server_url: String,
    /// Mỗi project đã tham gia một bản ghi.
    #[serde(default)]
    pub projects: Vec<ProjectConsent>,
}

/// Đồng ý cho một project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectConsent {
    pub project_id: String,
    pub project_slug: String,
    pub project_name: String,
    /// Phiên bản văn bản đồng ý đã gửi cùng `join`.
    pub text_version: String,
    /// Có gửi cả session cũ (trước lúc đồng ý) không.
    pub backfill: bool,
    pub accepted_at: DateTime<Utc>,
}

impl ConsentState {
    /// Bản đồng ý của một project, nếu có.
    pub fn project(&self, project_id: &str) -> Option<&ProjectConsent> {
        self.projects.iter().find(|p| p.project_id == project_id)
    }

    /// Session của `project_id`, hoạt động cuối lúc `last_activity`, có được gửi không.
    pub fn allows_session(&self, project_id: &str, last_activity: DateTime<Utc>) -> bool {
        self.project(project_id)
            .is_some_and(|p| p.backfill || last_activity >= p.accepted_at)
    }
}

/// Bản đồng ý còn hiệu lực cho server đang cấu hình (khác server hoặc rỗng → `None`).
pub fn current(config: &Config) -> Option<&ConsentState> {
    let server = config.server_url.as_deref()?;
    config
        .consent
        .as_ref()
        .filter(|c| c.server_url == server && !c.projects.is_empty())
}

/// Đã đồng ý cho server hiện tại chưa.
pub fn may_send(config: &Config) -> bool {
    current(config).is_some()
}

/// Ghi bản đồng ý của một project. Đổi sang server khác thì bỏ bản ghi của server cũ;
/// cùng project thì thay bản cũ.
pub fn record(config: &mut Config, server_url: &str, project: ProjectConsent) {
    let state = match &mut config.consent {
        Some(state) if state.server_url == server_url => state,
        slot => slot.insert(ConsentState {
            server_url: server_url.to_owned(),
            projects: Vec::new(),
        }),
    };
    state
        .projects
        .retain(|p| p.project_id != project.project_id);
    state.projects.push(project);
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn project(id: &str, backfill: bool) -> ProjectConsent {
        ProjectConsent {
            project_id: id.into(),
            project_slug: id.into(),
            project_name: id.into(),
            text_version: "2026-11-26".into(),
            backfill,
            accepted_at: Utc.with_ymd_and_hms(2026, 11, 27, 8, 0, 0).unwrap(),
        }
    }

    #[test]
    fn may_send_chi_khi_dong_y_dung_server() {
        let mut cfg = Config {
            server_url: Some("http://a".into()),
            ..Default::default()
        };
        assert!(!may_send(&cfg));
        record(&mut cfg, "http://a", project("p1", false));
        assert!(may_send(&cfg));
        cfg.server_url = Some("http://b".into());
        assert!(!may_send(&cfg), "đồng ý của server khác không tính");
    }

    #[test]
    fn record_thay_ban_cu_va_doi_server() {
        let mut cfg = Config::default();
        record(&mut cfg, "http://a", project("p1", false));
        record(&mut cfg, "http://a", project("p2", true));
        record(&mut cfg, "http://a", project("p1", true));
        let state = cfg.consent.as_ref().unwrap();
        assert_eq!(state.projects.len(), 2);
        assert!(state.project("p1").unwrap().backfill);

        record(&mut cfg, "http://b", project("p3", false));
        let state = cfg.consent.as_ref().unwrap();
        assert_eq!(state.server_url, "http://b");
        assert_eq!(state.projects.len(), 1);
    }

    #[test]
    fn khong_backfill_thi_bo_session_cu() {
        let mut cfg = Config::default();
        record(&mut cfg, "http://a", project("p1", false));
        record(&mut cfg, "http://a", project("p2", true));
        let state = cfg.consent.unwrap();
        let before = Utc.with_ymd_and_hms(2026, 11, 1, 0, 0, 0).unwrap();
        let after = Utc.with_ymd_and_hms(2026, 11, 28, 0, 0, 0).unwrap();
        assert!(!state.allows_session("p1", before));
        assert!(state.allows_session("p1", after));
        assert!(state.allows_session("p2", before));
        assert!(
            !state.allows_session("p-khac", after),
            "project chưa đồng ý"
        );
    }

    #[test]
    fn config_toml_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut cfg = Config {
            server_url: Some("http://a".into()),
            ..Default::default()
        };
        record(&mut cfg, "http://a", project("p1", false));
        cfg.save(&path).unwrap();
        assert_eq!(Config::load(&path).unwrap(), cfg);
    }
}
