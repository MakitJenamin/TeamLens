//! Trạng thái đồng ý cục bộ (SPEC 4.3).
//!
//! `tl join` ghi bản đồng ý vào `config.toml` (bảng `[consent]`) sau khi server nhận
//! `POST /agent/v1/join`: server nào, project nào, phiên bản văn bản, có backfill không,
//! đồng ý lúc nào. Pipeline gửi hỏi module này (qua `sync::consent_gate`) trước khi gửi:
//! - chưa đồng ý cho server hiện tại → không gửi gì;
//! - session thuộc project chưa đồng ý → không gửi;
//! - không backfill → bỏ session có hoạt động cuối trước thời điểm đồng ý.
//!
//! - đã rút đồng ý (`tl consent revoke`, [`ConsentState::revoked_at`]) → không gửi gì cho tới khi
//!   đồng ý lại bằng `tl consent` ([`regrant`]).
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
    /// Lúc người dùng rút đồng ý trên máy này (`tl consent revoke`). Còn giá trị thì máy không gửi gì
    /// cho tới khi đồng ý lại; danh sách `projects` được giữ để đồng ý lại không phải `tl join` lại.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<DateTime<Utc>>,
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
    /// Máy này đã rút đồng ý (và chưa đồng ý lại).
    pub fn is_revoked(&self) -> bool {
        self.revoked_at.is_some()
    }

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

/// Bản đồng ý đã lưu cho server đang cấu hình, **kể cả khi đã rút** (khác server hoặc rỗng → `None`).
/// `tl consent` dùng để hiện và đồng ý lại; việc gửi dữ liệu dùng [`current`].
pub fn stored(config: &Config) -> Option<&ConsentState> {
    let server = config.server_url.as_deref()?;
    config
        .consent
        .as_ref()
        .filter(|c| c.server_url == server && !c.projects.is_empty())
}

/// Bản đồng ý còn hiệu lực cho server đang cấu hình (khác server, rỗng hoặc đã rút → `None`).
pub fn current(config: &Config) -> Option<&ConsentState> {
    stored(config).filter(|c| !c.is_revoked())
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
            revoked_at: None,
        }),
    };
    state
        .projects
        .retain(|p| p.project_id != project.project_id);
    state.projects.push(project);
    // Đồng ý mới (`tl join`) thì không còn ở trạng thái đã rút.
    state.revoked_at = None;
}

/// Đánh dấu đã rút đồng ý trên máy (giữ nguyên danh sách project). Trả `false` khi máy chưa có
/// bản đồng ý nào cho server hiện tại.
pub fn revoke_local(config: &mut Config, at: DateTime<Utc>) -> bool {
    let Some(server) = config.server_url.clone() else {
        return false;
    };
    match &mut config.consent {
        Some(state) if state.server_url == server && !state.projects.is_empty() => {
            state.revoked_at = Some(at);
            true
        }
        _ => false,
    }
}

/// Đồng ý lại (`tl consent`): cập nhật mọi project đã lưu sang phiên bản văn bản mới và lựa chọn
/// backfill, đặt lại thời điểm đồng ý, bỏ trạng thái đã rút. Trả số project được cập nhật
/// (`0` khi máy chưa lưu project nào).
pub fn regrant(
    config: &mut Config,
    text_version: &str,
    backfill: bool,
    at: DateTime<Utc>,
) -> usize {
    let Some(server) = config.server_url.clone() else {
        return 0;
    };
    let Some(state) = config.consent.as_mut().filter(|c| c.server_url == server) else {
        return 0;
    };
    for project in &mut state.projects {
        project.text_version = text_version.to_owned();
        project.backfill = backfill;
        project.accepted_at = at;
    }
    state.revoked_at = None;
    state.projects.len()
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
    fn rut_dong_y_thi_current_none_nhung_stored_con_va_dong_y_lai_khoi_phuc() {
        let mut cfg = Config {
            server_url: Some("http://a".into()),
            ..Default::default()
        };
        assert!(!revoke_local(&mut cfg, Utc::now()), "chưa có gì để rút");
        record(&mut cfg, "http://a", project("p1", false));
        record(&mut cfg, "http://a", project("p2", true));
        assert!(may_send(&cfg));

        let at = Utc.with_ymd_and_hms(2026, 11, 28, 9, 0, 0).unwrap();
        assert!(revoke_local(&mut cfg, at));
        assert!(!may_send(&cfg), "đã rút thì không gửi");
        assert!(current(&cfg).is_none());
        let kept = stored(&cfg).expect("vẫn giữ danh sách project để đồng ý lại");
        assert!(kept.is_revoked());
        assert_eq!(kept.revoked_at, Some(at));
        assert_eq!(kept.projects.len(), 2);

        let again = Utc.with_ymd_and_hms(2026, 11, 29, 9, 0, 0).unwrap();
        assert_eq!(regrant(&mut cfg, "2026-12-01", true, again), 2);
        assert!(may_send(&cfg));
        let state = current(&cfg).unwrap();
        assert!(state
            .projects
            .iter()
            .all(|p| { p.text_version == "2026-12-01" && p.backfill && p.accepted_at == again }));
        assert!(!state.is_revoked());
    }

    #[test]
    fn join_moi_sau_khi_rut_thi_het_trang_thai_rut() {
        let mut cfg = Config {
            server_url: Some("http://a".into()),
            ..Default::default()
        };
        record(&mut cfg, "http://a", project("p1", false));
        revoke_local(&mut cfg, Utc::now());
        assert!(!may_send(&cfg));
        record(&mut cfg, "http://a", project("p2", false));
        assert!(may_send(&cfg), "đồng ý mới qua tl join thì gửi lại được");
    }

    #[test]
    fn regrant_khong_co_gi_de_cap_nhat() {
        let mut cfg = Config::default();
        assert_eq!(regrant(&mut cfg, "v2", false, Utc::now()), 0);
        cfg.server_url = Some("http://a".into());
        assert_eq!(regrant(&mut cfg, "v2", false, Utc::now()), 0);
        record(&mut cfg, "http://b", project("p1", false));
        assert_eq!(
            regrant(&mut cfg, "v2", false, Utc::now()),
            0,
            "bản đồng ý của server khác không bị động tới"
        );
    }

    #[test]
    fn config_cu_khong_co_revoked_at_van_doc_duoc() {
        let text = "server_url = \"http://a\"\n[consent]\nserver_url = \"http://a\"\n[[consent.projects]]\nproject_id = \"p1\"\nproject_slug = \"p1\"\nproject_name = \"p1\"\ntext_version = \"v1\"\nbackfill = false\naccepted_at = \"2026-11-27T08:00:00Z\"\n";
        let cfg: Config = toml::from_str(text).unwrap();
        assert!(may_send(&cfg));
        assert!(!cfg.consent.unwrap().is_revoked());
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
