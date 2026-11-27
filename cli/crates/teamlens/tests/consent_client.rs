//! Test `ApiClient::get_consent` / `update_consent` với mock server (wiremock).

use serde_json::json;
use teamlens::api_client::{
    ApiClient, ApiError, ApiErrorCode, ConsentStatus, ConsentUpdate, DeviceConsentState,
};
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TOKEN: &str = "tld_consent_token";

fn status_body(status: &str) -> serde_json::Value {
    json!({
        "textVersion": "2026-11-27.2",
        "text": "Văn bản đồng ý hiện hành.",
        "status": status,
        "acceptedVersion": null,
        "backfill": null,
        "grantedAt": null,
        "revokedAt": null
    })
}

fn client(server: &MockServer) -> ApiClient {
    ApiClient::new(&server.uri(), Some(TOKEN.to_owned())).unwrap()
}

#[tokio::test]
async fn get_consent_gui_bearer_va_doc_trang_thai() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/consent"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "textVersion": "2026-11-27.2",
            "text": "Văn bản đồng ý hiện hành.",
            "status": "outdated",
            "acceptedVersion": "2026-11-26",
            "backfill": true,
            "grantedAt": "2026-11-26T08:00:00.000Z",
            "revokedAt": null
        })))
        .expect(1)
        .mount(&server)
        .await;

    let status: ConsentStatus = client(&server).get_consent().await.unwrap();
    assert_eq!(status.status, DeviceConsentState::Outdated);
    assert_eq!(status.text_version, "2026-11-27.2");
    assert_eq!(status.accepted_version.as_deref(), Some("2026-11-26"));
    assert_eq!(status.backfill, Some(true));
}

#[tokio::test]
async fn update_consent_grant_va_revoke_gui_dung_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .and(body_json(json!({
            "action": "grant",
            "textVersion": "2026-11-27.2",
            "backfill": false
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(status_body("granted")))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .and(body_json(json!({ "action": "revoke" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(status_body("revoked")))
        .expect(1)
        .mount(&server)
        .await;

    let c = client(&server);
    let granted = c
        .update_consent(&ConsentUpdate::Grant {
            text_version: "2026-11-27.2".into(),
            backfill: false,
        })
        .await
        .unwrap();
    assert_eq!(granted.status, DeviceConsentState::Granted);
    let revoked = c.update_consent(&ConsentUpdate::Revoke).await.unwrap();
    assert_eq!(revoked.status, DeviceConsentState::Revoked);
}

#[tokio::test]
async fn update_consent_sai_phien_ban_la_consent_outdated() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/agent/v1/consent"))
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({
            "error": "consent_outdated",
            "message": "Văn bản đồng ý đã thay đổi, hãy xem lại và đồng ý lại."
        })))
        .mount(&server)
        .await;

    let err = client(&server)
        .update_consent(&ConsentUpdate::Grant {
            text_version: "cu".into(),
            backfill: false,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code(), Some(&ApiErrorCode::ConsentOutdated));
}

#[tokio::test]
async fn token_bi_thu_hoi_la_invalid_token() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/consent"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "error": "invalid_token",
            "message": "Token thiết bị không hợp lệ hoặc đã bị thu hồi."
        })))
        .mount(&server)
        .await;

    let err = client(&server).get_consent().await.unwrap_err();
    assert!(matches!(err, ApiError::Api { status: 401, .. }));
    assert_eq!(err.code(), Some(&ApiErrorCode::InvalidToken));
}

#[tokio::test]
async fn phan_hoi_sai_contract_la_invalid_response() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/agent/v1/consent"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "status": "nonsense" })))
        .mount(&server)
        .await;

    let err = client(&server).get_consent().await.unwrap_err();
    assert!(matches!(err, ApiError::InvalidResponse { status: 200, .. }));
}
