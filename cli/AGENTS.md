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

Chạy thử: `cargo run -p teamlens -- status`. Đổi thư mục config/state (thử nhiều server trên một máy): `TL_DATA_DIR=<thư mục>`; token vẫn nằm trong Credential Manager, khóa theo địa chỉ server. Bật log chi tiết: `TL_LOG=debug` (PowerShell: `$env:TL_LOG='debug'`).

Nếu shell không thấy `cargo`, dùng `%USERPROFILE%\.cargo\bin\cargo.exe`. Cần toolchain MSVC (VS Build Tools).

## Cấu trúc

| Crate | Nội dung | Ghi chú |
| --- | --- | --- |
| `crates/tl-core` | Logic thuần: `session` (M1.2), `scope` (M1.4), `redact` (M1.5, M2.1), `truncate` (M1.5) | **Không** phụ thuộc tokio, reqwest, không đọc/ghi file |
| `crates/tl-adapters` | Trait `Adapter` (spec 5.2), `AgentKind`, `SourceFile`, `Offset`, `RawEvent`, `ParseError`; `claude_code/` (M1.3, M2.3, M2.4), `codex/` (M2.5) | Fixtures ở `tests/fixtures/`, phải che trước khi commit |
| `crates/tl-platform` | Trait `Platform` (thư mục dữ liệu, credential store, named mutex, Task Scheduler) + impl Windows; OS khác trả "chưa hỗ trợ" | Task Scheduler qua COM (`scheduler.rs`, M3.8); test chạm Task Scheduler thật là `#[ignore]` (chạy tay `cargo test -p tl-platform -- --ignored`) |
| `crates/teamlens` | Binary `tl` + thư viện: `cli`, `commands/` (mỗi lệnh một file), `api_client`, `config`, `context`, `error`; khung `pipeline/` (M1.7), `state/` (`state.db`, M2.3), `queue/` (M3.1), `daemon/` (M3.2), `sync/` (M1.7) | Test tích hợp ở `tests/` |

Thêm thư viện: mọi dependency đã khai báo sẵn trong `[workspace.dependencies]` của `Cargo.toml` gốc. Crate con chỉ thêm dòng `ten = { workspace = true }` cho thứ nó dùng. Cần thư viện mới ngoài danh sách thì sửa `Cargo.toml` gốc bằng PR riêng (vùng nền).

## Vùng file

Vùng sở hữu của Người 1 và Người 2 trong `cli/`: bảng ở `AGENTS.md` gốc, mục 3. Module `crates/teamlens/src/consent/` lưu trạng thái đồng ý cục bộ (bảng `[consent]` trong `config.toml`, ghi bởi `tl join`); pipeline gửi hỏi nó qua `sync::consent_gate::may_send()`.

**Vùng nền** (đã làm ở F8, sửa thì PR riêng nhỏ): `Cargo.toml` workspace, `rust-toolchain.toml`, lệnh `logout`, `api_client`, `config`, `context`, `error`, `cli.rs`, `main.rs`.

## Quy ước

- **Lỗi cho người dùng:** dùng `AppError` (`crates/teamlens/src/error.rs`). Thông điệp tiếng Việt, ngắn, kèm gợi ý cách sửa (`AppError::user(message, hint)`). `main` in `Lỗi: ...` và `Gợi ý: ...`; chỉ in chi tiết/nguyên nhân khi `TL_LOG=debug`. Không `unwrap()`/`panic!` trên đường chạy thật.
- **Mã thoát:** 0 thành công, 1 lỗi, 2 lệnh chưa làm (`AppError::NotImplemented { command, task }` in `Chưa làm: lệnh <x> thuộc task <mã>`).
- **Lỗi API:** server luôn trả `{ "error": "<mã>", "message": "<mô tả>" }`; `api_client` chuyển thành `ApiError::Api { status, code: ApiErrorCode, message }`. Mã mới chưa có biến thể thì rơi vào `ApiErrorCode::Other`.
- **JSON:** REST `/agent/v1` dùng camelCase (`#[serde(rename_all = "camelCase")]`); payload session ingest theo schema v1 snake_case.
- **Token:** chỉ nằm trong Credential Manager (`tl_platform::CredentialStore`, service `teamlens`, account = server URL). Không ghi vào `config.toml`, không in ra log (`Debug` của kiểu chứa token phải che).
- **Config/state:** `%LOCALAPPDATA%\teamlens\` (`config.toml`, `state.db`; `state.db` nằm cạnh `config.toml` nên theo `TL_DATA_DIR`), lấy qua `Platform::data_dir()`.
- **Test:** lệnh nhận `&AppContext` và `&mut dyn Write` để test thay được: `MemoryCredentialStore` thay Credential Manager, config trong `tempfile`, `poll_unit` 1 ms, mock server bằng `wiremock`. Test không bao giờ đụng Credential Manager thật hay mở trình duyệt.
- Comment và thông báo tiếng Việt; tên biến, hàm, file tiếng Anh.
