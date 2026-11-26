//! Đọc file JSONL (mỗi dòng một giá trị JSON) từ một offset, dùng chung cho các adapter.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;

use crate::{Offset, ParseError, RawEvent, MAX_LINE_BYTES};

/// Đọc các dòng JSONL từ `from` tới hết những dòng đã hoàn chỉnh.
///
/// - Dòng trống bị bỏ qua.
/// - Dòng dài hơn [`MAX_LINE_BYTES`] chỉ giữ phần đầu trong RAM (phần còn lại đọc bỏ),
///   nên không parse được và trả về [`RawEvent::unparsed`].
/// - Dòng JSON hỏng cũng thành [`RawEvent::unparsed`]; không bao giờ trả lỗi vì một dòng.
/// - Dòng cuối chưa có `\n` (agent đang ghi dở) KHÔNG được đọc; offset trả về dừng ở
///   đầu dòng đó để lần sau đọc lại khi đã đủ.
///
/// Trả về các bản ghi và offset kế tiếp. Lỗi chỉ khi không mở/đọc được file.
pub fn read_jsonl(path: &Path, from: Offset) -> Result<(Vec<RawEvent>, Offset), ParseError> {
    let io_err = |source: io::Error| ParseError::Io {
        path: path.to_path_buf(),
        source,
    };
    let mut file = File::open(path).map_err(io_err)?;
    file.seek(SeekFrom::Start(from.0)).map_err(io_err)?;
    read_from(BufReader::new(file), from, MAX_LINE_BYTES).map_err(io_err)
}

/// Phần lõi của [`read_jsonl`], tách ra để test với giới hạn dòng nhỏ.
pub(crate) fn read_from<R: BufRead>(
    mut reader: R,
    from: Offset,
    max_line: usize,
) -> io::Result<(Vec<RawEvent>, Offset)> {
    let mut events = Vec::new();
    let mut offset = from.0;
    let mut buf = Vec::new();
    loop {
        let line = read_line_capped(&mut reader, &mut buf, max_line)?;
        if line.consumed == 0 || !line.complete {
            break;
        }
        let start = Offset(offset);
        offset += line.consumed;
        let text = buf.trim_ascii();
        if text.is_empty() {
            continue;
        }
        let value = if line.truncated {
            None
        } else {
            serde_json::from_slice(text).ok()
        };
        events.push(match value {
            Some(value) => RawEvent {
                offset: start,
                value,
            },
            None => RawEvent::unparsed(start),
        });
    }
    Ok((events, Offset(offset)))
}

struct Line {
    /// Số byte đã đọc khỏi file (kể cả phần bị bỏ và `\n`).
    consumed: u64,
    /// Có kết thúc bằng `\n`.
    complete: bool,
    /// Bị cắt vì quá giới hạn.
    truncated: bool,
}

/// Đọc một dòng vào `buf`, giữ tối đa `cap` byte; phần thừa đọc rồi bỏ.
fn read_line_capped<R: BufRead>(reader: &mut R, buf: &mut Vec<u8>, cap: usize) -> io::Result<Line> {
    buf.clear();
    let mut line = Line {
        consumed: 0,
        complete: false,
        truncated: false,
    };
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(line);
        }
        let (chunk_len, done) = match available.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, true),
            None => (available.len(), false),
        };
        let room = cap.saturating_sub(buf.len());
        if chunk_len > room {
            buf.extend_from_slice(&available[..room]);
            // Phần bị cắt có thể chứa chính `\n`; vẫn tính là cắt (JSON chắc chắn dở dang).
            line.truncated = line.truncated || chunk_len - room > usize::from(done);
        } else {
            buf.extend_from_slice(&available[..chunk_len]);
        }
        reader.consume(chunk_len);
        line.consumed += chunk_len as u64;
        if done {
            line.complete = true;
            return Ok(line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(input: &str, max: usize) -> (Vec<RawEvent>, Offset) {
        read_from(input.as_bytes(), Offset(0), max).unwrap()
    }

    #[test]
    fn reads_complete_lines_and_skips_blank() {
        let (events, next) = read("{\"a\":1}\r\n\n{\"b\":2}\n", 1024);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].offset, Offset(0));
        assert_eq!(events[1].offset, Offset(10));
        assert_eq!(events[1].value["b"], 2);
        assert_eq!(next, Offset(18));
    }

    #[test]
    fn broken_json_becomes_unparsed() {
        let (events, _) = read("{\"a\":\n{\"ok\":true}\n", 1024);
        assert!(events[0].is_unparsed());
        assert!(!events[1].is_unparsed());
    }

    #[test]
    fn partial_last_line_is_not_consumed() {
        let (events, next) = read("{\"a\":1}\n{\"b\":", 1024);
        assert_eq!(events.len(), 1);
        assert_eq!(next, Offset(8));
    }

    #[test]
    fn long_line_is_cut_and_reading_continues() {
        let long = format!("{{\"img\":\"{}\"}}\n", "x".repeat(100));
        let input = format!("{long}{{\"after\":1}}\n");
        let (events, next) = read(&input, 32);
        assert_eq!(events.len(), 2);
        assert!(events[0].is_unparsed());
        assert_eq!(events[1].value["after"], 1);
        assert_eq!(events[1].offset, Offset(long.len() as u64));
        assert_eq!(next, Offset(input.len() as u64));
    }

    #[test]
    fn line_exactly_at_cap_is_kept() {
        // 7 byte JSON + `\n`: cap 7 chỉ bỏ đúng `\n` nên vẫn parse được.
        let (events, _) = read("{\"a\":1}\n", 7);
        assert_eq!(events[0].value["a"], 1);
    }

    #[test]
    fn starts_from_offset() {
        let input = "{\"a\":1}\n{\"b\":2}\n";
        let mut reader = &input.as_bytes()[8..];
        let (events, next) = read_from(&mut reader, Offset(8), 1024).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].offset, Offset(8));
        assert_eq!(next, Offset(16));
    }
}
