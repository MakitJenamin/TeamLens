//! Đóng [`IngestBatch`] và chia nhỏ theo kích thước (server nhận tối đa 10 MB sau giải
//! nén; CLI giữ mỗi batch dưới ~8 MB JSON để còn dư), nén gzip.

use std::io::Write;

use flate2::write::GzEncoder;
use flate2::Compression;
use tl_core::session::{IngestBatch, SessionEnvelope};
use uuid::Uuid;

/// Kích thước JSON tối đa (trước gzip) của một batch.
pub const MAX_BATCH_JSON_BYTES: usize = 8 * 1024 * 1024;

/// Phần dư cho vỏ batch (`schema_version`, `batch_id`, dấu phẩy...).
const BATCH_OVERHEAD: usize = 128;

fn json_len<T: serde::Serialize>(v: &T) -> usize {
    serde_json::to_vec(v).map(|b| b.len()).unwrap_or(usize::MAX)
}

/// Chia một session quá lớn thành nhiều envelope cùng metadata, mỗi envelope một
/// đoạn turn liên tiếp (server upsert turn theo `seq` nên gửi rời vẫn đúng).
/// Một turn riêng lẻ vẫn vượt ngưỡng thì đứng một mình (đã cắt theo spec 6.3 nên hiếm).
pub fn split_envelope(env: SessionEnvelope, max_bytes: usize) -> Vec<SessionEnvelope> {
    if json_len(&env) + BATCH_OVERHEAD <= max_bytes || env.turns.len() <= 1 {
        return vec![env];
    }
    let SessionEnvelope { session, turns } = env;
    let base = json_len(&SessionEnvelope {
        session: session.clone(),
        turns: Vec::new(),
    }) + BATCH_OVERHEAD;
    let mut out = Vec::new();
    let mut chunk = Vec::new();
    let mut size = base;
    for turn in turns {
        let len = json_len(&turn) + 1;
        if !chunk.is_empty() && size + len > max_bytes {
            out.push(SessionEnvelope {
                session: session.clone(),
                turns: std::mem::take(&mut chunk),
            });
            size = base;
        }
        size += len;
        chunk.push(turn);
    }
    out.push(SessionEnvelope {
        session,
        turns: chunk,
    });
    out
}

/// Gom các envelope thành nhóm, mỗi nhóm thành một batch có JSON < `max_bytes`
/// (trừ khi một envelope đơn lẻ đã lớn hơn). Giữ thứ tự.
pub fn group_envelopes(
    envelopes: Vec<SessionEnvelope>,
    max_bytes: usize,
) -> Vec<Vec<SessionEnvelope>> {
    let mut groups = Vec::new();
    let mut current: Vec<SessionEnvelope> = Vec::new();
    let mut size = BATCH_OVERHEAD;
    for env in envelopes
        .into_iter()
        .flat_map(|e| split_envelope(e, max_bytes))
    {
        let len = json_len(&env) + 1;
        if !current.is_empty() && size + len > max_bytes {
            groups.push(std::mem::take(&mut current));
            size = BATCH_OVERHEAD;
        }
        size += len;
        current.push(env);
    }
    if !current.is_empty() {
        groups.push(current);
    }
    groups
}

/// Batch mới với `batch_id` uuid v4.
pub fn new_batch(sessions: Vec<SessionEnvelope>) -> IngestBatch {
    IngestBatch::new(Uuid::new_v4(), sessions)
}

/// JSON của batch nén gzip.
pub fn gzip_json(batch: &IngestBatch) -> std::io::Result<Vec<u8>> {
    let json = serde_json::to_vec(batch).map_err(std::io::Error::other)?;
    let mut enc = GzEncoder::new(Vec::with_capacity(json.len() / 4), Compression::default());
    enc.write_all(&json)?;
    enc.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use std::io::Read;
    use tl_core::session::{AgentKind, Role, Session, Turn, TurnKind};

    fn env(id: &str, turns: u32, text_len: usize) -> SessionEnvelope {
        let ts = Utc.with_ymd_and_hms(2026, 11, 26, 9, 0, 0).unwrap();
        SessionEnvelope {
            session: Session {
                source_id: format!("claude_code:{id}"),
                agent: AgentKind::ClaudeCode,
                agent_version: None,
                repo_remote: "github.com/acme/shop".into(),
                branch: None,
                cwd_relative: Some(String::new()),
                started_at: ts,
                ended_at: None,
                parent_source_id: None,
                permission_mode: None,
                instruction_files: None,
            },
            turns: (0..turns)
                .map(|seq| {
                    let mut t = Turn::new(seq, Role::User, TurnKind::Prompt, ts);
                    t.text = Some("x".repeat(text_len));
                    t
                })
                .collect(),
        }
    }

    #[test]
    fn gom_nhom_theo_kich_thuoc() {
        let envs = vec![env("a", 3, 1000), env("b", 3, 1000), env("c", 1, 10)];
        // Đủ lớn: một nhóm.
        assert_eq!(group_envelopes(envs.clone(), 1 << 20).len(), 1);
        // Mỗi session ~3.5 KB: ngưỡng 5 KB → mỗi nhóm tối đa một session lớn.
        let groups = group_envelopes(envs, 5_000);
        assert_eq!(groups.len(), 2);
        for g in &groups {
            assert!(json_len(&new_batch(g.clone())) <= 5_000);
        }
    }

    #[test]
    fn session_qua_lon_chia_theo_turn() {
        let parts = split_envelope(env("big", 10, 1000), 3_500);
        assert!(parts.len() > 1);
        let seqs: Vec<u32> = parts
            .iter()
            .flat_map(|p| p.turns.iter().map(|t| t.seq))
            .collect();
        assert_eq!(seqs, (0..10).collect::<Vec<_>>());
        for p in &parts {
            assert_eq!(p.session.source_id, "claude_code:big");
            assert!(json_len(p) + BATCH_OVERHEAD <= 3_500);
        }
    }

    #[test]
    fn gzip_giai_nen_lai_dung() {
        let batch = new_batch(vec![env("a", 2, 50)]);
        let gz = gzip_json(&batch).unwrap();
        let mut text = String::new();
        flate2::read::GzDecoder::new(&gz[..])
            .read_to_string(&mut text)
            .unwrap();
        let back: IngestBatch = serde_json::from_str(&text).unwrap();
        assert_eq!(back, batch);
        assert_eq!(back.schema_version, 1);
    }
}
