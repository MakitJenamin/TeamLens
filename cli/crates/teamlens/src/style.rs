//! Tô màu output của `tl` khi in ra terminal.
//!
//! Lệnh vẫn ghi chữ thường vào `&mut dyn Write`; `main` bọc stdout bằng [`Painter`] (stderr chỉ tô dòng lỗi qua [`write_line`]) để
//! tô màu theo dạng dòng (tiêu đề, nhãn, lệnh trong dấu backtick, câu hỏi...). Test ghi vào
//! buffer nên không bị ảnh hưởng. Tắt màu khi không phải terminal hoặc đặt `NO_COLOR`.

use std::io::{self, IsTerminal, Write};

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const RED: &str = "\x1b[31m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const CYAN: &str = "\x1b[36m";

/// Có nên tô màu cho luồng này không (terminal thật, không `NO_COLOR`, Windows bật được ANSI).
pub fn enabled_for(stream: &impl IsTerminal) -> bool {
    if !stream.is_terminal() || anstyle_query::no_color() {
        return false;
    }
    #[cfg(windows)]
    {
        anstyle_query::windows::enable_ansi_colors().unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// Bọc một `Write`, tô màu từng dòng trước khi ghi ra. `enabled = false` thì ghi nguyên văn.
pub struct Painter<W: Write> {
    inner: W,
    enabled: bool,
    buf: Vec<u8>,
}

impl<W: Write> Painter<W> {
    pub fn new(inner: W, enabled: bool) -> Self {
        Self {
            inner,
            enabled,
            buf: Vec::new(),
        }
    }

    fn emit_lines(&mut self) -> io::Result<()> {
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&line[..line.len() - 1]);
            let text = text.strip_suffix('\r').unwrap_or(&text);
            let painted = paint_line(text);
            self.inner.write_all(painted.as_bytes())?;
            self.inner.write_all(b"\n")?;
        }
        Ok(())
    }
}

impl<W: Write> Write for Painter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if !self.enabled {
            return self.inner.write(data);
        }
        self.buf.extend_from_slice(data);
        self.emit_lines()?;
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.enabled && !self.buf.is_empty() {
            // Phần còn lại chưa xuống dòng là câu hỏi đang chờ người dùng gõ.
            let rest = String::from_utf8_lossy(&std::mem::take(&mut self.buf)).into_owned();
            self.inner.write_all(paint_prompt(&rest).as_bytes())?;
        }
        self.inner.flush()
    }
}

impl<W: Write> Drop for Painter<W> {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

fn paint(color: &str, text: &str) -> String {
    format!("{color}{text}{RESET}")
}

/// Lệnh trong dấu backtick (`tl sync`) tô xanh, bỏ dấu backtick.
fn code_spans(text: &str) -> String {
    let parts: Vec<&str> = text.split('`').collect();
    if parts.len() < 3 || parts.len() % 2 == 0 {
        return text.to_owned();
    }
    parts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            if i % 2 == 1 {
                paint(CYAN, p)
            } else {
                (*p).to_owned()
            }
        })
        .collect()
}

/// Tách "Nhãn:   giá trị" (nhãn ngắn, không có backtick). Trả (nhãn kèm khoảng trắng, giá trị).
fn split_label(line: &str) -> Option<(&str, &str)> {
    let first = line.chars().next()?;
    if first.is_whitespace() || first == '-' {
        return None;
    }
    let colon = line.find(':')?;
    let label = &line[..colon];
    if label.chars().count() > 20 || label.contains('`') || label.contains('.') {
        return None;
    }
    let after = &line[colon + 1..];
    if after.is_empty() {
        return Some((line, ""));
    }
    if !after.starts_with(' ') {
        return None;
    }
    let value_start = colon + 1 + (after.len() - after.trim_start().len());
    Some((&line[..value_start], &line[value_start..]))
}

/// Tô một dòng output hoàn chỉnh (không có ký tự xuống dòng).
pub fn paint_line(line: &str) -> String {
    let trimmed = line.trim_start();
    // Dòng trống và JSON (`tl preview`, `--json`) giữ nguyên văn.
    if trimmed.is_empty() || trimmed.starts_with(['{', '}', '[', ']', '"']) {
        return line.to_owned();
    }
    if trimmed.starts_with("══") || trimmed.starts_with("──") {
        return paint(&format!("{BOLD}{CYAN}"), line);
    }
    if let Some(rest) = line.strip_prefix("Lỗi:") {
        return format!(
            "{}{}",
            paint(&format!("{BOLD}{RED}"), "Lỗi:"),
            code_spans(rest)
        );
    }
    if let Some(rest) = line.strip_prefix("Gợi ý:") {
        return format!(
            "{}{}",
            paint(&format!("{BOLD}{YELLOW}"), "Gợi ý:"),
            code_spans(rest)
        );
    }
    if line.starts_with("Cảnh báo") {
        return paint(YELLOW, line);
    }
    if line.starts_with("Đã ") {
        return paint(GREEN, &code_spans(line));
    }
    if line.ends_with(':') && !line.starts_with(' ') && !line.starts_with('-') {
        return paint(BOLD, line);
    }
    if let Some((label, value)) = split_label(line) {
        if value.is_empty() {
            return paint(BOLD, label);
        }
        return format!("{}{}", paint(BOLD, label), code_spans(value));
    }
    code_spans(line)
}

/// Câu hỏi đang chờ nhập: in đậm, giữ nguyên khoảng trắng cuối để con trỏ đứng sau.
fn paint_prompt(text: &str) -> String {
    let body = text.trim_end();
    let tail = &text[body.len()..];
    format!("{}{tail}", paint(&format!("{BOLD}{YELLOW}"), body))
}

/// Ghi vào `out` một dòng đã tô (dùng cho stderr của `main`).
pub fn write_line(out: &mut dyn Write, enabled: bool, line: &str) {
    let _ = if enabled {
        writeln!(out, "{}", paint_line(line))
    } else {
        writeln!(out, "{line}")
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn painted(input: &str) -> String {
        let mut out = Vec::new();
        {
            let mut p = Painter::new(&mut out, true);
            p.write_all(input.as_bytes()).unwrap();
            p.flush().unwrap();
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn tat_mau_thi_ghi_nguyen_van() {
        let mut out = Vec::new();
        {
            let mut p = Painter::new(&mut out, false);
            write!(p, "Gửi ngay: `tl sync`.\nTên: ").unwrap();
            p.flush().unwrap();
        }
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "Gửi ngay: `tl sync`.\nTên: "
        );
    }

    #[test]
    fn to_lenh_nhan_tieu_de_va_cau_hoi() {
        let s = painted("══ Tham gia TeamLens ══\nGửi ngay: `tl sync`.\nTên hiển thị: ");
        assert!(s.contains(&format!("{BOLD}{CYAN}══ Tham gia TeamLens ══{RESET}")));
        assert!(s.contains(&format!("{CYAN}tl sync{RESET}")), "{s:?}");
        assert!(!s.contains('`'));
        assert!(
            s.ends_with(&format!("{BOLD}{YELLOW}Tên hiển thị:{RESET} ")),
            "{s:?}"
        );
    }

    #[test]
    fn dong_thanh_cong_mau_xanh_la() {
        let s = paint_line("Đã tham gia project Nice.");
        assert!(s.starts_with(GREEN));
    }

    #[test]
    fn nhan_va_gia_tri() {
        assert_eq!(
            split_label("Server:   http://x"),
            Some(("Server:   ", "http://x"))
        );
        assert_eq!(split_label("Dữ liệu:"), Some(("Dữ liệu:", "")));
        assert_eq!(split_label("- Tạm dừng: `tl pause`."), None);
        assert_eq!(split_label("Chạy lại. Sau đó: x"), None);
        // Câu có dấu hai chấm sau backtick không phải nhãn.
        assert_eq!(split_label("Gõ `yes` để đồng ý: "), None);
    }
}
