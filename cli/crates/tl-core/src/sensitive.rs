//! Nhận ra file nhạy cảm mà agent đọc/sửa (spec 6.2) — task M2.1.
//!
//! Nội dung file `.env*`, `*.pem`, `*.key` (và khóa SSH riêng `id_rsa`, `id_ed25519`...)
//! không bao giờ được gửi: pipeline thay toàn bộ output/diff bằng
//! `[REDACTED:sensitive_file]`. Module này chỉ quyết định "có phải file nhạy cảm không"
//! từ đường dẫn hoặc từ câu lệnh shell; việc thay thế nằm ở `teamlens::pipeline::prepare`.
//!
//! **File mẫu được giữ lại:** `.env.example`, `.env.sample`, `.env.template`,
//! `.env.dist`, `.env.defaults` thường được commit vào repo và chỉ chứa giá trị giữ
//! chỗ, nên không coi là nhạy cảm; nội dung của chúng vẫn qua bộ che secret thường
//! ([`crate::redact`]), nên nếu ai lỡ ghi khóa thật vào đó thì khóa vẫn bị che.
//!
//! ```
//! use tl_core::sensitive::{command_reads_sensitive_file, is_sensitive_path};
//!
//! assert!(is_sensitive_path("apps/api/.env.local"));
//! assert!(!is_sensitive_path(".env.example"));
//! assert!(command_reads_sensitive_file("cat apps/api/.env | grep DB"));
//! assert!(command_reads_sensitive_file(r"Get-Content -Raw C:\x\server.pem"));
//! assert!(!command_reads_sensitive_file("cp .env.example .env"));
//! ```

/// Hậu tố của file `.env` mẫu (giữ lại, xem tài liệu module).
const ENV_TEMPLATE_SUFFIXES: &[&str] = &["example", "sample", "template", "dist", "defaults"];

/// Tên file khóa SSH riêng mặc định (không có `.pub`).
const SSH_PRIVATE_KEYS: &[&str] = &[
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_ecdsa_sk",
    "id_ed25519_sk",
];

/// `.env`, `.env.local`, `.envrc`, `server.pem`, `id.key`, `id_rsa`... (không phân biệt
/// hoa thường, nhận cả `/` và `\`, cả mẫu glob như `*.pem`, `.env*`).
pub fn is_sensitive_path(path: &str) -> bool {
    let name = path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase();
    if let Some(rest) = name.strip_prefix(".env") {
        // `.env.example`, `.env.sample`... là file mẫu.
        let suffix = rest.trim_start_matches(['.', '-', '_']);
        return !ENV_TEMPLATE_SUFFIXES.contains(&suffix);
    }
    name.ends_with(".pem") || name.ends_with(".key") || SSH_PRIVATE_KEYS.contains(&name.as_str())
}

/// Lệnh in nội dung file ra output (bash, cmd, PowerShell). So sánh sau khi bỏ đường dẫn,
/// đuôi `.exe` và chuyển chữ thường.
const READ_COMMANDS: &[&str] = &[
    // bash/coreutils
    "cat",
    "tac",
    "nl",
    "less",
    "more",
    "most",
    "head",
    "tail",
    "bat",
    "batcat",
    "view",
    "strings",
    "xxd",
    "od",
    "hexdump",
    "base64",
    "sed",
    "awk",
    "gawk",
    "cut",
    "sort",
    "uniq",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "ag",
    "ack",
    "jq",
    "yq",
    "diff",
    "openssl",
    "iconv",
    "dotenv",
    // cmd
    "type",
    "findstr",
    // PowerShell
    "get-content",
    "gc",
    "select-string",
    "sls",
    "format-hex",
    "fhx",
    "import-csv",
];

/// Phương thức .NET đọc file trong PowerShell (`[IO.File]::ReadAllText('.env')`).
const READ_METHODS: &[&str] = &["readalltext", "readalllines", "readallbytes", "readlines"];

/// Câu lệnh shell có đọc/in nội dung một file nhạy cảm không: có ít nhất một lệnh đọc
/// file ([`READ_COMMANDS`]) và ít nhất một đối số là file nhạy cảm ([`is_sensitive_path`]).
///
/// Cố ý bảo thủ (xét cả câu lệnh, kể cả lệnh lồng như `powershell -c "gc .env"` hay
/// `bash -lc 'cat .env'`): thà bỏ nhầm output của một lệnh còn hơn để lọt nội dung `.env`.
pub fn command_reads_sensitive_file(command: &str) -> bool {
    let tokens: Vec<&str> = command
        .split(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '"' | '\''
                        | '`'
                        | '|'
                        | ';'
                        | '&'
                        | '<'
                        | '>'
                        | '('
                        | ')'
                        | '{'
                        | '}'
                        | ','
                        | '='
                )
        })
        .filter(|t| !t.is_empty())
        .collect();
    let has_reader = tokens.iter().any(|t| {
        let lower = t.to_ascii_lowercase();
        let name = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
        let name = name.strip_suffix(".exe").unwrap_or(name);
        READ_COMMANDS.contains(&name) || READ_METHODS.iter().any(|m| lower.contains(m))
    });
    has_reader
        && tokens.iter().any(|t| {
            // Bỏ tiền tố tham số kiểu `-Path:` và dấu câu dính kèm.
            let t = t.trim_matches(|c: char| matches!(c, '[' | ']' | ':' | '!' | '$'));
            !t.starts_with('-') && is_sensitive_path(t)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_paths() {
        for p in [
            ".env",
            "a/.env.production",
            r"C:\repo\apps\api\.env.local",
            ".envrc",
            ".env*",
            r"C:\x\server.PEM",
            "*.pem",
            "id.key",
            "~/.ssh/id_rsa",
            r"C:\Users\u\.ssh\id_ed25519",
        ] {
            assert!(is_sensitive_path(p), "{p}");
        }
        for p in [
            "src/env.rs",
            "keys.rs",
            "README.md",
            "~/.ssh/id_rsa.pub",
            "environment.ts",
            "monkey.rs",
        ] {
            assert!(!is_sensitive_path(p), "{p}");
        }
    }

    #[test]
    fn env_templates_are_kept() {
        for p in [
            ".env.example",
            "apps/api/.env.sample",
            ".env.template",
            ".env.dist",
            ".ENV.EXAMPLE",
            ".env-example",
        ] {
            assert!(!is_sensitive_path(p), "{p}");
        }
    }

    #[test]
    fn shell_reads() {
        for cmd in [
            "cat .env",
            "cat apps/api/.env.local | grep DATABASE",
            "head -n 5 .env",
            "less ~/.ssh/id_rsa",
            "type .env",
            r"type C:\repo\.env",
            "Get-Content .env",
            "Get-Content -Path ./certs/server.pem -Raw",
            "gc .env.production",
            r"C:\Windows\System32\findstr.exe KEY .env",
            "grep -r SECRET .env*",
            "cd api && cat *.key",
            "powershell -NoProfile -Command \"Get-Content '.env'\"",
            "bash -lc 'cat .env'",
            "[IO.File]::ReadAllText('.env')",
            "openssl rsa -in private.key -text",
            "Select-String -Path .env -Pattern TOKEN",
        ] {
            assert!(command_reads_sensitive_file(cmd), "{cmd}");
        }
    }

    #[test]
    fn shell_non_reads() {
        for cmd in [
            "cat README.md",
            "cat .env.example",
            "cp .env.example .env",
            "echo .env >> .gitignore",
            "git status",
            "ls -la .env",
            "rm .env.local",
            "docker compose --env-file .env up -d",
            "cargo test -p tl-core",
            "grep -r env src/",
        ] {
            assert!(!command_reads_sensitive_file(cmd), "{cmd}");
        }
    }
}
