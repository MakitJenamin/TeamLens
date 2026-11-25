# cli/ — hướng dẫn cho agent và người đóng góp

`tl.exe`: CLI + daemon chạy trên máy thành viên. Đọc [AGENTS.md gốc](../AGENTS.md) và [docs/SPEC.md](../docs/SPEC.md) mục 4–6 trước.

## Lệnh

Chạy trong thư mục `cli/`:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release          # ra target/release/tl.exe
```

Chạy thử: `cargo run -p teamlens -- status`. Bật log chi tiết: `TL_LOG=debug` (PowerShell: `$env:TL_LOG='debug'`).

Nếu shell không thấy `cargo`, dùng `%USERPROFILE%\.cargo\bin\cargo.exe`. Cần toolchain MSVC (VS Build Tools).

## Cấu trúc

| Crate | Nội dung | Ghi chú |
| --- | --- | --- |
| `crates/tl-core` | Logic thuần: `session` (A1), `scope` (A4), `redact` (A5), `truncate` (A5) | **Không** phụ thuộc tokio, reqwest, không đọc/ghi file |
| `crates/tl-adapters` | Trait `Adapter` (spec 5.2), `AgentKind`, `SourceFile`, `Offset`, `RawEvent`, `ParseError`; `claude_code/` (A2, A3), `codex/` (A9) | Fixtures ở `tests/fixtures/`, phải che trước khi commit |
| `crates/tl-platform` | Trait `Platform` (thư mục dữ liệu, credential store, named mutex, Task Scheduler) + impl Windows; OS khác trả "chưa hỗ trợ" | Task Scheduler là task B4 |
| `crates/teamlens` | Binary `tl` + thư viện: `cli`, `commands/` (mỗi lệnh một file), `api_client`, `config`, `context`, `error`; khung `pipeline/` (A7), `queue/` (A10), `daemon/` (A11), `sync/` (A7) | Test tích hợp ở `tests/` |

Thêm thư viện: mọi dependency đã khai báo sẵn trong `[workspace.dependencies]` của `Cargo.toml` gốc. Crate con chỉ thêm dòng `ten = { workspace = true }` cho thứ nó dùng. Cần thư viện mới ngoài danh sách thì sửa `Cargo.toml` gốc bằng PR riêng (vùng nền).

## Vùng sở hữu trong cli (từ AGENTS.md gốc, mục 3)

| A · Đường dữ liệu | B · Con người và điểm số |
| --- | --- |
| `crates/tl-core`, `crates/tl-adapters`, `crates/teamlens/src/{pipeline,queue,daemon,sync}/`, lệnh `status`, `preview`, `sync`, `daemon`, `pause`, `resume` | `crates/tl-platform`, lệnh `join`, `consent`, `uninstall` |

**Vùng nền** (đã làm ở F8, sửa thì PR riêng nhỏ): `Cargo.toml` workspace, `rust-toolchain.toml`, lệnh `login`/`logout`, `api_client`, `config`, `context`, `error`, `cli.rs`, `main.rs`.

## Quy ước

- **Lỗi cho người dùng:** dùng `AppError` (`crates/teamlens/src/error.rs`). Thông điệp tiếng Việt, ngắn, kèm gợi ý cách sửa (`AppError::user(message, hint)`). `main` in `Lỗi: ...` và `Gợi ý: ...`; chỉ in chi tiết/nguyên nhân khi `TL_LOG=debug`. Không `unwrap()`/`panic!` trên đường chạy thật.
- **Mã thoát:** 0 thành công, 1 lỗi, 2 lệnh chưa làm (`AppError::NotImplemented { command, task }` in `Chưa làm: lệnh <x> thuộc task <mã>`).
- **Lỗi API:** server luôn trả `{ "error": "<mã>", "message": "<mô tả>" }`; `api_client` chuyển thành `ApiError::Api { status, code: ApiErrorCode, message }`. Mã mới chưa có biến thể thì rơi vào `ApiErrorCode::Other`.
- **JSON:** REST `/agent/v1` dùng camelCase (`#[serde(rename_all = "camelCase")]`); payload session ingest theo schema v1 snake_case.
- **Token:** chỉ nằm trong Credential Manager (`tl_platform::CredentialStore`, service `teamlens`, account = server URL). Không ghi vào `config.toml`, không in ra log (`Debug` của kiểu chứa token phải che).
- **Config/state:** `%LOCALAPPDATA%\teamlens\` (`config.toml`, sau này `state.db`), lấy qua `Platform::data_dir()`.
- **Test:** lệnh nhận `&AppContext` và `&mut dyn Write` để test thay được: `MemoryCredentialStore` thay Credential Manager, config trong `tempfile`, `poll_unit` 1 ms, mock server bằng `wiremock`. Test không bao giờ đụng Credential Manager thật hay mở trình duyệt.
- Comment và thông báo tiếng Việt; tên biến, hàm, file tiếng Anh.
