//! Parse file `SHA256SUMS` (kiểu `sha256sum`: `<hex>  <tên file>`) và kiểm SHA-256.

use sha2::{Digest, Sha256};

/// Một dòng hợp lệ của `SHA256SUMS`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SumEntry {
    /// SHA-256 dạng hex thường (64 ký tự).
    pub sha256: String,
    pub file_name: String,
}

/// Parse nội dung `SHA256SUMS`. Chấp nhận `<hex>  <tên>` (text mode), `<hex> *<tên>`
/// (binary mode); bỏ dòng trống, dòng `#`, dòng sai dạng.
pub fn parse(text: &str) -> Vec<SumEntry> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (hex, rest) = line.split_once(char::is_whitespace)?;
            if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            let name = rest.trim_start();
            let name = name.strip_prefix('*').unwrap_or(name).trim_end();
            // `dist/tl.zip` → so theo tên file cuối.
            let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
            if name.is_empty() {
                return None;
            }
            Some(SumEntry {
                sha256: hex.to_ascii_lowercase(),
                file_name: name.to_owned(),
            })
        })
        .collect()
}

/// SHA-256 mong đợi của `file_name` (so tên chính xác). `None` nếu không có dòng nào.
pub fn expected_for(text: &str, file_name: &str) -> Option<String> {
    parse(text)
        .into_iter()
        .find(|e| e.file_name == file_name)
        .map(|e| e.sha256)
}

/// SHA-256 của `data`, hex thường.
pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZIP: &str = "tl-x86_64-pc-windows-msvc.zip";
    const H1: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const H2: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn sha256_dung_vector_chuan() {
        assert_eq!(sha256_hex(b""), H1);
        assert_eq!(sha256_hex(b"abc"), H2);
    }

    #[test]
    fn parse_dinh_dang_sha256sum() {
        let text = format!("{H1}  {ZIP}\n{H2}  other.txt\n");
        let entries = parse(&text);
        assert_eq!(entries.len(), 2);
        assert_eq!(expected_for(&text, ZIP).as_deref(), Some(H1));
        assert_eq!(expected_for(&text, "other.txt").as_deref(), Some(H2));
        assert_eq!(expected_for(&text, "khong-co.zip"), None);
    }

    #[test]
    fn parse_chap_nhan_bien_the_va_bo_dong_sai() {
        let upper = H2.to_ascii_uppercase();
        let text = format!(
            "# comment\r\n\r\n{upper} *{ZIP}\r\nzzzz  hong.zip\r\n{H1}\r\n{H1}  dist/tl.zip\r\n"
        );
        assert_eq!(
            expected_for(&text, ZIP).as_deref(),
            Some(H2),
            "binary mode `*`, hex hoa, CRLF"
        );
        assert_eq!(expected_for(&text, "tl.zip").as_deref(), Some(H1));
        assert_eq!(expected_for(&text, "hong.zip"), None, "hash sai dạng bị bỏ");
        assert_eq!(parse(&text).len(), 2);
    }

    #[test]
    fn ten_file_so_chinh_xac() {
        let text = format!("{H1}  {ZIP}.bak\n{H2}  TL-X86_64-PC-WINDOWS-MSVC.ZIP\n");
        assert_eq!(expected_for(&text, ZIP), None);
    }
}
