//! Test cầu nối `tl mcp` (M6.4) với server MCP giả (wiremock): chuyển nguyên văn từng dòng JSON-RPC
//! lên `POST /api/v1/mcp` bằng device token, in phản hồi ra stdout mỗi message một dòng, và biến lỗi
//! thành lỗi JSON-RPC cho đúng request. Stdin đưa vào qua `Cursor`.

use std::io::Cursor;
use std::time::Duration;

use serde_json::{json, Value};
use teamlens::api_client::{sse_data_events, ApiClient};
use teamlens::commands::mcp::{self, McpArgs};
use teamlens::config::Config;
use teamlens::context::AppContext;
use teamlens::error::AppError;
use tempfile::TempDir;
use tl_platform::MemoryCredentialStore;
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TOKEN: &str = "tld_mcp_bridge_token";

fn client(server: &MockServer) -> ApiClient {
    ApiClient::new(&server.uri(), Some(TOKEN.to_owned())).unwrap()
}

/// Chạy cầu nối với `input` làm stdin, trả về các dòng stdout đã parse thành JSON.
async fn run(client: &ApiClient, input: &str) -> Vec<Value> {
    let mut out: Vec<u8> = Vec::new();
    mcp::run_with(client, Cursor::new(input.as_bytes().to_vec()), &mut out)
        .await
        .unwrap();
    String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).expect("mỗi dòng stdout phải là một message JSON"))
        .collect()
}

#[tokio::test]
async fn chuyen_request_len_server_kem_token_va_in_phan_hoi_mot_dong() {
    let server = MockServer::start().await;
    let request = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
    // Phản hồi của server có xuống dòng bên trong (thụt lề) vẫn phải ra stdout trên đúng một dòng.
    Mock::given(method("POST"))
        .and(path("/api/v1/mcp"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .and(body_json(request.clone()))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            "{\n  \"jsonrpc\": \"2.0\",\n  \"id\": 1,\n  \"result\": { \"tools\": [] }\n}",
            "application/json",
        ))
        .expect(1)
        .mount(&server)
        .await;

    let replies = run(&client(&server), &format!("{request}\n")).await;
    assert_eq!(
        replies,
        vec![json!({"jsonrpc":"2.0","id":1,"result":{"tools":[]}})]
    );
    // Server MCP bắt buộc client chấp nhận cả hai kiểu phản hồi (đặc tả Streamable HTTP).
    let received = server.received_requests().await.unwrap();
    assert_eq!(received.len(), 1);
    let accept = received[0].headers.get("accept").unwrap().to_str().unwrap();
    assert!(accept.contains("application/json") && accept.contains("text/event-stream"));
    assert_eq!(
        received[0]
            .headers
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap(),
        "application/json"
    );
}

#[tokio::test]
async fn notification_tra_202_thi_khong_in_gi() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/mcp"))
        .respond_with(ResponseTemplate::new(202))
        .expect(1)
        .mount(&server)
        .await;
    let input = "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n";
    assert!(run(&client(&server), input).await.is_empty());
}

#[tokio::test]
async fn nhieu_dong_xu_ly_tuan_tu_bo_dong_trong() {
    let server = MockServer::start().await;
    for id in [1, 2] {
        Mock::given(method("POST"))
            .and(body_json(json!({"jsonrpc":"2.0","id":id,"method":"ping"})))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"jsonrpc":"2.0","id":id,"result":{}})),
            )
            .expect(1)
            .mount(&server)
            .await;
    }
    let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n\n   \n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}";
    let replies = run(&client(&server), input).await;
    assert_eq!(
        replies.iter().map(|r| r["id"].clone()).collect::<Vec<_>>(),
        vec![json!(1), json!(2)]
    );
}

#[tokio::test]
async fn token_het_hieu_luc_tra_loi_json_rpc_cho_dung_request() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/mcp"))
        .respond_with(ResponseTemplate::new(401).set_body_json(
            json!({"error":"invalid_token","message":"Token không hợp lệ hoặc đã bị thu hồi."}),
        ))
        .mount(&server)
        .await;
    let input = "{\"jsonrpc\":\"2.0\",\"id\":\"abc\",\"method\":\"tools/list\"}\n";
    let replies = run(&client(&server), input).await;
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["id"], json!("abc"));
    assert_eq!(replies[0]["error"]["code"], json!(-32000));
    let message = replies[0]["error"]["message"].as_str().unwrap();
    assert!(message.contains("tl join"), "{message}");
}

#[tokio::test]
async fn loi_o_notification_khong_in_gi() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500).set_body_string("loi may chu"))
        .mount(&server)
        .await;
    let input = "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n";
    assert!(run(&client(&server), input).await.is_empty());
}

#[tokio::test]
async fn mat_mang_tra_loi_json_rpc_va_van_chay_tiep() {
    // Cổng không có ai lắng nghe: kết nối bị từ chối.
    let dead = ApiClient::new("http://127.0.0.1:1", Some(TOKEN.to_owned())).unwrap();
    let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n";
    let replies = run(&dead, input).await;
    assert_eq!(replies.len(), 2);
    for (reply, id) in replies.iter().zip([1, 2]) {
        assert_eq!(reply["id"], json!(id));
        assert!(reply["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Không kết nối được"));
    }
}

#[tokio::test]
async fn dong_khong_phai_json_tra_loi_parse_error() {
    let server = MockServer::start().await; // không mock: nếu bị gọi sẽ trả 404
    let replies = run(&client(&server), "khong phai json\n").await;
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["id"], Value::Null);
    assert_eq!(replies[0]["error"]["code"], json!(-32700));
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn batch_loi_tra_mot_loi_cho_moi_request_bo_notification() {
    let dead = ApiClient::new("http://127.0.0.1:1", Some(TOKEN.to_owned())).unwrap();
    let input = r#"[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","method":"n"},{"jsonrpc":"2.0","id":2,"method":"b"}]"#;
    let replies = run(&dead, &format!("{input}\n")).await;
    assert_eq!(
        replies.iter().map(|r| r["id"].clone()).collect::<Vec<_>>(),
        vec![json!(1), json!(2)]
    );
}

#[tokio::test]
async fn server_tra_event_stream_thi_lay_tung_su_kien_data() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"a\":1}}\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\n\n",
            "text/event-stream",
        ))
        .mount(&server)
        .await;
    let replies = run(
        &client(&server),
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"x\"}\n",
    )
    .await;
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["result"], json!({"a":1}));
}

#[test]
fn sse_data_events_nhieu_dong_data_noi_bang_xuong_dong() {
    let text = "data: dong1\ndata: dong2\n\n: ghi chu\ndata:khong-cach\n";
    assert_eq!(sse_data_events(text), vec!["dong1\ndong2", "khong-cach"]);
    assert!(sse_data_events("event: ping\n\n").is_empty());
}

fn ctx(dir: &TempDir) -> AppContext {
    AppContext {
        config_path: dir.path().join("teamlens").join("config.toml"),
        credentials: Box::new(MemoryCredentialStore::new()),
        poll_unit: Duration::from_millis(1),
        open_browser: |_| panic!("test không được mở trình duyệt"),
    }
}

#[tokio::test]
async fn chua_tham_gia_thi_bao_loi_va_goi_y_tl_join() {
    let dir = TempDir::new().unwrap();
    let ctx = ctx(&dir);
    let mut out: Vec<u8> = Vec::new();
    let err = mcp::run(&ctx, McpArgs {}, &mut out).await.unwrap_err();
    assert!(matches!(err, AppError::User { .. }));
    assert!(err.to_string().contains("chưa tham gia"));
    assert!(err.hint().unwrap().contains("tl join"));
    assert!(
        out.is_empty(),
        "stdout không được có gì ngoài message giao thức"
    );
}

#[tokio::test]
async fn co_cau_hinh_nhung_mat_token_cung_bao_chua_tham_gia() {
    let dir = TempDir::new().unwrap();
    let ctx = ctx(&dir);
    ctx.save_config(&Config {
        server_url: Some("http://127.0.0.1:1".to_owned()),
        ..Default::default()
    })
    .unwrap();
    let mut out: Vec<u8> = Vec::new();
    let err = mcp::run(&ctx, McpArgs {}, &mut out).await.unwrap_err();
    assert!(err.to_string().contains("chưa tham gia"));
    assert!(out.is_empty());
}
