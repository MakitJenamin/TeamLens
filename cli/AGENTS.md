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
| `crates/teamlens` | Binary `tl` + thư viện: `cli`, `commands/` (mỗi lệnh một file), `api_client`, `config`, `context`, `error`; khung `pipeline/` (M1.7), `state/` (`state.db`, M2.3), `queue/` (M3.1), `daemon/` (M3.2), `sync/` (M1.7), `update/` (tự cập nhật, M5.3) | Test tích hợp ở `tests/` |

Thêm thư viện: mọi dependency đã khai báo sẵn trong `[workspace.dependencies]` của `Cargo.toml` gốc. Crate con chỉ thêm dòng `ten = { workspace = true }` cho thứ nó dùng. Cần thư viện mới ngoài danh sách thì sửa `Cargo.toml` gốc bằng PR riêng (vùng nền).

## Vùng file

Vùng sở hữu của Người 1, 2, 3 trong `cli/` (Người 3 từ Mốc 6: `crates/teamlens/src/mcp/` và lệnh `tl mcp`, cầu nối stdio ↔ `/api/v1/mcp` bằng device token, xem [docs/AI_PLAN.md](../docs/AI_PLAN.md) mục 4): bảng ở `AGENTS.md` gốc, mục 3. Module `crates/teamlens/src/consent/` lưu trạng thái đồng ý cục bộ (bảng `[consent]` trong `config.toml`, ghi bởi `tl join` và `tl consent`; có `revoked_at` khi đã `tl consent revoke`); pipeline gửi hỏi nó qua `sync::consent_gate::may_send()`.

**Vùng nền** (đã làm ở F8, sửa thì PR riêng nhỏ): `Cargo.toml` workspace, `rust-toolchain.toml`, lệnh `logout`, `api_client`, `config`, `context`, `error`, `cli.rs`, `main.rs`.

## Phát hành CLI

Workflow `.github/workflows/release.yml` (M5.1) build `tl.exe` và đưa lên GitHub Releases của `MakitJenamin/TeamLens`.

1. **Bump version:** sửa `version` ở `[workspace.package]` của `cli/Cargo.toml` (mọi crate dùng chung), chạy `cargo build` để cập nhật `Cargo.lock`, PR vào `main` như thường.
2. **Tạo tag** trên commit đã merge: `git tag v<version>` rồi `git push origin v<version>` (vd `v0.2.0`; bản thử `v0.1.1-rc.1`). Tag bỏ `v` phải bằng đúng version trong `Cargo.toml`, sai thì workflow fail ngay và nói rõ lệch gì.
3. **Workflow làm:** kiểm tag khớp version → `cargo build --release --locked --target x86_64-pc-windows-msvc -p teamlens` trên `windows-latest` → `scripts/package-release.ps1` smoke test `tl.exe --version` (phải in `tl <version>`), tạo zip và `SHA256SUMS` → job `release` kiểm lại checksum rồi `gh release create --verify-tag --generate-notes` (tag có `-` thì là prerelease). Chạy lại trên cùng tag thì ghi đè asset (`--clobber`), không lỗi.
4. **Chạy tay** (Actions → Release CLI → Run workflow): nhập `tag` đã có để build lại release của tag đó; để trống thì chỉ build và upload artifact `tl-x86_64-pc-windows-msvc` của workflow, không tạo release (dùng để thử).

Asset của mỗi release (tên không chứa phiên bản, tải được qua `releases/latest/download/<asset>` hoặc `releases/download/<tag>/<asset>`):
- `tl-x86_64-pc-windows-msvc.zip`: đúng một file `tl.exe` ở gốc zip.
- `SHA256SUMS`: mỗi dòng `<sha256 hex thường>  <tên file>` (kiểu `sha256sum`), hiện chỉ có dòng của zip. Bộ cài (`install.ps1`, `tl update`) chỉ tìm dòng của zip và luôn kiểm SHA-256 trước khi giải nén; sai thì dừng.
- `install.ps1`, `install.cmd`: script cài chung, chép nguyên từ `deploy/install.ps1` và `deploy/install.cmd` của commit được tag.

**Cài `tl` lên máy thành viên** (một lệnh chung, không phụ thuộc server, không kèm mã mời):

```powershell
# PowerShell (Windows PowerShell 5.1 hoặc 7)
irm https://github.com/MakitJenamin/TeamLens/releases/latest/download/install.ps1 | iex
```

```bat
:: CMD
curl -fsSL https://github.com/MakitJenamin/TeamLens/releases/latest/download/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Script tải zip + `SHA256SUMS` từ `releases/latest/download`, kiểm SHA-256 rồi cài `%LOCALAPPDATA%\teamlens\bin\tl.exe`, thêm thư mục đó vào PATH của user (registry `HKCU\Environment`, giữ `REG_EXPAND_SZ`) và cửa sổ đang mở dùng được `tl` ngay. Máy đã có `tl.exe` thì không tải đè (daemon có thể đang giữ file), chỉ in phiên bản và gợi ý `tl update`. Tham gia nhóm là bước riêng: `tl join https://<server>/i/<mã>`.

Sửa `deploy/install.ps1`: file phải là **ASCII thuần** (GitHub trả asset dạng `application/octet-stream`, `irm | iex` trên PowerShell 5.1 giải mã bằng Latin-1, chữ có dấu và BOM đều làm hỏng script), nên comment viết không dấu, còn thông báo tiếng Việt ghi bằng mã `\uXXXX` qua hàm `Write-Vi`; workflow release kiểm ASCII và cú pháp. Thử trên máy: phục vụ thư mục chứa zip, `SHA256SUMS`, `install.ps1`, `install.cmd` bằng `python -m http.server 8766 --bind 127.0.0.1`, đặt `TEAMLENS_INSTALL_BASE_URL=http://127.0.0.1:8766` và `TEAMLENS_INSTALL_TEST_ENV_KEY=Software\TeamLensInstallTest` (ghi PATH vào khóa test thay cho PATH thật), trỏ `LOCALAPPDATA`/`TEMP` sang thư mục tạm, rồi chạy `irm http://127.0.0.1:8766/install.ps1 | iex`. Xong thì xóa khóa `HKCU\Software\TeamLensInstallTest`.

Thử đóng gói trên máy (PowerShell, trong `cli/`):

```powershell
cargo build --release --locked --target x86_64-pc-windows-msvc -p teamlens
./scripts/package-release.ps1 -BinaryPath target/x86_64-pc-windows-msvc/release/tl.exe -OutDir ../dist -ExpectedVersion 0.1.0
```

Chưa ký số (code signing) `tl.exe`; SmartScreen có thể cảnh báo khi chạy lần đầu.

## Tự cập nhật và dòng nhắc bản mới

Module `crates/teamlens/src/update/` (M5.3): `tl update` cập nhật tay, daemon tự kiểm mỗi 24 giờ (`update::auto`), kết quả lưu ở bảng `meta` của `state.db` (`update_latest_version`, `update_last_check_at`, `update_last_attempt_at`...).

Dòng nhắc (`update::notice`, gọi trong `main.rs` sau khi lệnh chạy xong, kể cả khi lệnh lỗi): in ra **stderr** `` Có bản tl <mới> (đang dùng <cũ>). Chạy `tl update`. `` khi bản đã lưu mới hơn bản đang chạy.
- Không nhắc ở `update`, `daemon`, `uninstall`, `status` (có dòng "Phiên bản" riêng); không nhắc khi stderr không phải terminal; tắt bằng `TL_NO_UPDATE_NOTIFIER=1` hoặc khi biến `CI` được đặt.
- Bình thường chỉ đọc `state.db`. Kết quả cũ hơn 24 giờ (hoặc chưa có) **và** lần thử gần nhất cách hơn 1 giờ thì kiểm nhẹ trên thread riêng, chạy song song với lệnh; lệnh xong chờ thêm tối đa 2 giây, HTTP timeout 3 giây. Mốc thử ghi trước khi gọi mạng. Kiểm thành công thì dùng kết quả mới; lỗi, timeout hoặc hết giờ chờ thì dùng bản đã lưu (máy đã biết có bản mới thì vẫn nhắc), chỉ im lặng khi chưa lưu gì. Lỗi không ghi `update_last_error` (để `tl status` chỉ báo lỗi của daemon/`tl update`).
- Mọi lỗi bị nuốt, không đổi kết quả hay mã thoát của lệnh. Tôn trọng `TL_UPDATE_BASE_URL`/`TL_UPDATE_VERSION`/`TL_UPDATE_API_URL`.
- Test cần stderr là terminal: `NoticeOptions { stderr_is_terminal: true, .. }` (xem `tests/update_notice.rs`). Chạy thật thì chạy trong cửa sổ terminal, không qua pipe.

## Quy ước

- **Lỗi cho người dùng:** dùng `AppError` (`crates/teamlens/src/error.rs`). Thông điệp tiếng Việt, ngắn, kèm gợi ý cách sửa (`AppError::user(message, hint)`). `main` in `Lỗi: ...` và `Gợi ý: ...`; chỉ in chi tiết/nguyên nhân khi `TL_LOG=debug`. Không `unwrap()`/`panic!` trên đường chạy thật.
- **Mã thoát:** 0 thành công, 1 lỗi, 2 lệnh chưa làm (`AppError::NotImplemented { command, task }` in `Chưa làm: lệnh <x> thuộc task <mã>`).
- **Lỗi API:** server luôn trả `{ "error": "<mã>", "message": "<mô tả>" }`; `api_client` chuyển thành `ApiError::Api { status, code: ApiErrorCode, message }`. Mã mới chưa có biến thể thì rơi vào `ApiErrorCode::Other`.
- **JSON:** REST `/agent/v1` dùng camelCase (`#[serde(rename_all = "camelCase")]`); payload session ingest theo schema v1 snake_case.
- **Token:** chỉ nằm trong Credential Manager (`tl_platform::CredentialStore`, service `teamlens`, account = server URL). Không ghi vào `config.toml`, không in ra log (`Debug` của kiểu chứa token phải che).
- **Config/state:** `%LOCALAPPDATA%\teamlens\` (`config.toml`, `state.db`; `state.db` nằm cạnh `config.toml` nên theo `TL_DATA_DIR`), lấy qua `Platform::data_dir()`.
- **Test:** lệnh nhận `&AppContext` và `&mut dyn Write` để test thay được: `MemoryCredentialStore` thay Credential Manager, config trong `tempfile`, `poll_unit` 1 ms, mock server bằng `wiremock`. Test không bao giờ đụng Credential Manager thật hay mở trình duyệt.
- **Màu:** lệnh chỉ ghi chữ thường; `main` bọc stdout bằng `style::Painter` và tô dòng `Lỗi:`/`Gợi ý:` trên stderr bằng `style::write_line` (`crates/teamlens/src/style.rs`) để tô màu theo dạng dòng: khung `══`/`──`, nhãn `Nhãn:`, lệnh trong dấu backtick (tô màu, bỏ dấu backtick), dòng `Đã ...`, câu hỏi chờ nhập, `Lỗi:`/`Gợi ý:`. Dòng JSON giữ nguyên. Màu tắt khi không phải terminal hoặc có `NO_COLOR`; test ghi vào buffer nên luôn là chữ thường.
- **Chữ hiển thị:** ngắn, không kể lại việc nội bộ (hàng đợi, heartbeat, Task Scheduler), mỗi ý một dòng, lỗi kèm lệnh cần chạy. Quy tắc theo unslop-ui và stop-describing-ui.
- Comment và thông báo tiếng Việt; tên biến, hàm, file tiếng Anh.
