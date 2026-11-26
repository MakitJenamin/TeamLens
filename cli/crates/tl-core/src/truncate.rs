//! Cắt output dài theo ngưỡng (spec mục 6.3) — task M1.5.
//!
//! Mọi hàm cắt theo **byte UTF-8** nhưng luôn dừng ở ranh giới ký tự, nên kết quả
//! là `String` hợp lệ (có thể giữ ít hơn ngưỡng vài byte). Phần bị bỏ được thay
//! bằng một dấu hiệu ghi số byte đã cắt, ví dụ `…[đã cắt 1234 byte]…`.
//!
//! Gọi **sau khi** che secret ([`crate::redact`]) để `original_bytes` là kích thước
//! đã che và không có secret nào bị cắt đôi rồi lọt qua regex.
//!
//! ```
//! use tl_core::truncate::{truncate_output, TruncateLimits};
//!
//! let long = "a".repeat(10_000);
//! let out = truncate_output(&long, &TruncateLimits::default());
//! assert!(out.truncated);
//! assert_eq!(out.original_bytes, 10_000);
//! assert!(out.text.contains("[đã cắt 6928 byte]"));
//! ```

/// Output đọc file / chạy lệnh / tìm kiếm: số byte giữ ở đầu (2 KB).
pub const OUTPUT_HEAD_BYTES: usize = 2 * 1024;
/// Output đọc file / chạy lệnh / tìm kiếm: số byte giữ ở cuối (1 KB).
pub const OUTPUT_TAIL_BYTES: usize = 1024;
/// Thinking/reasoning: tối đa 8 KB mỗi block.
pub const THINKING_MAX_BYTES: usize = 8 * 1024;
/// Input của tool: tối đa 4 KB.
pub const TOOL_INPUT_MAX_BYTES: usize = 4 * 1024;
/// Diff code (Edit, Write, apply_patch): tối đa 256 KB mỗi diff.
pub const DIFF_MAX_BYTES: usize = 256 * 1024;

/// Các ngưỡng cắt. Mặc định theo spec 6.3; admin chỉnh được trên server
/// (M1.7/M2.1 nạp từ config rồi truyền vào).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TruncateLimits {
    /// Byte giữ ở đầu output tool.
    pub output_head: usize,
    /// Byte giữ ở cuối output tool.
    pub output_tail: usize,
    /// Byte tối đa mỗi block thinking.
    pub thinking_max: usize,
    /// Byte tối đa của input tool.
    pub tool_input_max: usize,
    /// Byte tối đa mỗi diff.
    pub diff_max: usize,
}

impl Default for TruncateLimits {
    fn default() -> Self {
        Self {
            output_head: OUTPUT_HEAD_BYTES,
            output_tail: OUTPUT_TAIL_BYTES,
            thinking_max: THINKING_MAX_BYTES,
            tool_input_max: TOOL_INPUT_MAX_BYTES,
            diff_max: DIFF_MAX_BYTES,
        }
    }
}

/// Kết quả cắt; khớp các trường `text`, `truncated`, `original_bytes` của
/// `Output` trong schema session v1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Truncated {
    /// Văn bản sau khi cắt (nguyên văn nếu không cắt).
    pub text: String,
    /// `true` nếu có phần bị bỏ.
    pub truncated: bool,
    /// Kích thước văn bản gốc tính bằng byte UTF-8.
    pub original_bytes: usize,
}

/// Dấu hiệu chèn vào chỗ bị cắt.
pub fn marker(dropped_bytes: usize) -> String {
    format!("…[đã cắt {dropped_bytes} byte]…")
}

/// Vị trí ranh giới ký tự lớn nhất `<= index`.
fn floor_char_boundary(s: &str, index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    let mut i = index;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Vị trí ranh giới ký tự nhỏ nhất `>= index`.
fn ceil_char_boundary(s: &str, index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    let mut i = index;
    while !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Giữ tối đa `head` byte đầu và `tail` byte cuối, chèn [`marker`] ở giữa.
///
/// Không cắt nếu `text.len() <= head + tail`. Số byte trong dấu hiệu là số byte
/// gốc thực sự bị bỏ (đã tính phần lùi về ranh giới ký tự).
pub fn truncate_head_tail(text: &str, head: usize, tail: usize) -> Truncated {
    let len = text.len();
    if len <= head.saturating_add(tail) {
        return Truncated {
            text: text.to_owned(),
            truncated: false,
            original_bytes: len,
        };
    }
    let head_end = floor_char_boundary(text, head);
    let tail_start = ceil_char_boundary(text, len - tail);
    let dropped = tail_start - head_end;
    let mark = marker(dropped);
    let mut out = String::with_capacity(head_end + mark.len() + (len - tail_start) + 2);
    out.push_str(&text[..head_end]);
    out.push('\n');
    out.push_str(&mark);
    out.push('\n');
    out.push_str(&text[tail_start..]);
    Truncated {
        text: out,
        truncated: true,
        original_bytes: len,
    }
}

/// Giữ tối đa `max` byte đầu, nối [`marker`] ở cuối nếu bị cắt.
pub fn truncate_head(text: &str, max: usize) -> Truncated {
    let len = text.len();
    if len <= max {
        return Truncated {
            text: text.to_owned(),
            truncated: false,
            original_bytes: len,
        };
    }
    let end = floor_char_boundary(text, max);
    let mark = marker(len - end);
    let mut out = String::with_capacity(end + mark.len() + 1);
    out.push_str(&text[..end]);
    out.push('\n');
    out.push_str(&mark);
    Truncated {
        text: out,
        truncated: true,
        original_bytes: len,
    }
}

/// Output đọc file, chạy lệnh, tìm kiếm: giữ `output_head` byte đầu và
/// `output_tail` byte cuối (mặc định 2 KB + 1 KB).
pub fn truncate_output(text: &str, limits: &TruncateLimits) -> Truncated {
    truncate_head_tail(text, limits.output_head, limits.output_tail)
}

/// Block thinking/reasoning: tối đa `thinking_max` byte (mặc định 8 KB).
pub fn truncate_thinking(text: &str, limits: &TruncateLimits) -> Truncated {
    truncate_head(text, limits.thinking_max)
}

/// Diff code: tối đa `diff_max` byte (mặc định 256 KB).
pub fn truncate_diff(text: &str, limits: &TruncateLimits) -> Truncated {
    truncate_head(text, limits.diff_max)
}

/// Input tool dạng văn bản (ví dụ JSON đã serialize): tối đa `tool_input_max`
/// byte (mặc định 4 KB).
///
/// Lưu ý cho M1.7: cắt chuỗi JSON làm hỏng cấu trúc; nên cắt từng giá trị chuỗi
/// bên trong (hoặc thay input bằng object chứa bản đã cắt) để payload vẫn là
/// object hợp lệ theo schema.
pub fn truncate_tool_input(text: &str, limits: &TruncateLimits) -> Truncated {
    truncate_head(text, limits.tool_input_max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_untouched() {
        let out = truncate_output("xin chào", &TruncateLimits::default());
        assert_eq!(
            out,
            Truncated {
                text: "xin chào".into(),
                truncated: false,
                original_bytes: "xin chào".len(),
            }
        );
    }

    #[test]
    fn exact_limit_not_truncated() {
        let text = "x".repeat(OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES);
        let out = truncate_output(&text, &TruncateLimits::default());
        assert!(!out.truncated);
        assert_eq!(out.text, text);
    }

    #[test]
    fn one_byte_over_limit() {
        let text = format!("{}{}", "h".repeat(2048), "t".repeat(1025));
        let out = truncate_output(&text, &TruncateLimits::default());
        assert!(out.truncated);
        assert_eq!(out.original_bytes, 3073);
        assert_eq!(
            out.text,
            format!("{}\n{}\n{}", "h".repeat(2048), marker(1), "t".repeat(1024))
        );
    }

    #[test]
    fn keeps_head_and_tail() {
        let text = format!("ĐẦU{}CUỐI", "-".repeat(10_000));
        let out = truncate_head_tail(&text, 10, 10);
        assert!(out.text.starts_with("ĐẦU"));
        assert!(out.text.ends_with("CUỐI"));
        assert_eq!(out.original_bytes, text.len());
    }

    #[test]
    fn utf8_boundaries_head_tail() {
        // Mỗi "ệ" là 3 byte; ngưỡng 4 rơi giữa ký tự.
        let text = "ệ".repeat(10); // 30 byte
        let out = truncate_head_tail(&text, 4, 4);
        // Đầu lùi về 3 byte (1 ký tự), cuối tiến tới 27 (giữ 1 ký tự).
        assert_eq!(out.text, format!("ệ\n{}\nệ", marker(24)));
        assert!(out.truncated);
        assert_eq!(out.original_bytes, 30);
    }

    #[test]
    fn utf8_boundaries_emoji() {
        let text = "🎉".repeat(5); // 4 byte mỗi ký tự
        for max in 0..=20 {
            let out = truncate_head(&text, max);
            // Luôn là String hợp lệ và không vượt ngưỡng phần nội dung.
            let kept = out.text.split('\n').next().unwrap_or_default();
            assert!(kept.len() <= max);
            assert_eq!(kept.len() % 4, 0);
        }
    }

    #[test]
    fn head_only_truncation() {
        let out = truncate_head("abcdefghij", 4);
        assert_eq!(out.text, format!("abcd\n{}", marker(6)));
        assert!(out.truncated);
        assert_eq!(out.original_bytes, 10);
        assert!(!truncate_head("abcd", 4).truncated);
    }

    #[test]
    fn zero_limits() {
        let out = truncate_head_tail("abc", 0, 0);
        assert_eq!(out.text, format!("\n{}\n", marker(3)));
        let out = truncate_head("abc", 0);
        assert_eq!(out.text, format!("\n{}", marker(3)));
    }

    #[test]
    fn per_kind_limits() {
        let limits = TruncateLimits::default();
        let big = "a".repeat(300 * 1024);
        assert_eq!(
            truncate_thinking(&big, &limits).text.find('\n'),
            Some(8 * 1024)
        );
        assert_eq!(
            truncate_tool_input(&big, &limits).text.find('\n'),
            Some(4 * 1024)
        );
        assert_eq!(
            truncate_diff(&big, &limits).text.find('\n'),
            Some(256 * 1024)
        );
        assert!(!truncate_diff(&"a".repeat(1000), &limits).truncated);
    }

    #[test]
    fn custom_limits() {
        let limits = TruncateLimits {
            output_head: 2,
            output_tail: 1,
            ..TruncateLimits::default()
        };
        let out = truncate_output("abcdef", &limits);
        assert_eq!(out.text, format!("ab\n{}\nf", marker(3)));
    }
}
