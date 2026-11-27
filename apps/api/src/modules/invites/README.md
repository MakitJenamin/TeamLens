Link mời chung và tham gia bằng `tl join` (task J.3, SPEC 7.1; contract `packages/schema/openapi/invites.yaml`).

- `invites.controller.ts`: dashboard (`/api/v1/projects/:projectId/invites`, chỉ leader) và CLI công khai (`GET /agent/v1/invites/:code`, `POST /agent/v1/join`, 10 request/phút mỗi IP, tính chung).
- `invites.service.ts`: `join` chạy một transaction, `SELECT ... FOR UPDATE` dòng invite rồi kiểm tra lại; máy mới tạo user member + thiết bị + đồng ý, máy có token chỉ thêm vào project.
- `invite-factory.ts`: tạo link (dùng chung với wizard setup). `invite-status.ts`: tính `status`, lỗi 404/410.

### Script cài đặt `GET /install.ps1` (M3.6)

`irm <server>/install.ps1?code=<mã> | iex` (contract `invites.yaml`). Code: `InstallScriptController` trong `invites.controller.ts`, script sinh ở `install-script.ts` (thuần, có test).

- Công khai, cùng bộ đếm 10 request/phút mỗi IP với xem trước và join. Trả `text/plain; charset=utf-8`, `Cache-Control: no-store`.
- Chỉ kiểm tra **định dạng** mã (`INVITE_CODE_RE`, chỉ gồm `A-Za-z0-9_-`); sai thì `404 invite_not_found` dạng JSON. **Không** kiểm tra link còn dùng được (việc của `tl join`, qua `GET /agent/v1/invites/:code`). Địa chỉ server (`TEAMLENS_PUBLIC_URL`) được thoát nháy đơn khi nhúng, nên không có đường nhúng lệnh lạ vào script.
- Script tìm `tl.exe` (PATH hoặc `%LOCALAPPDATA%\teamlens\bin\tl.exe`); **chưa có thì tải (M5.2)** `SHA256SUMS` và `tl-x86_64-pc-windows-msvc.zip` từ `TEAMLENS_CLI_RELEASE_URL` (mặc định GitHub Releases `latest/download`, phải `https:`, `http:` chỉ cho localhost/127.0.0.1) vào thư mục tạm riêng, kiểm SHA-256 trước khi giải nén (sai thì dừng, không cài), cài vào `%LOCALAPPDATA%\teamlens\bin`, thêm thư mục vào PATH của user (registry `HKCU\Environment`, giữ `REG_EXPAND_SZ`, không trùng) và của phiên hiện tại; rồi chạy `tl join <server>/i/<mã>`. Đã có `tl.exe` thì không tải lại (cập nhật do `tl` tự lo, M5.3). TLS 1.2, progress bar và encoding đổi tạm, khôi phục trong `finally`. `TEAMLENS_INSTALL_TEST_ENV_KEY` chỉ dành cho test (ghi PATH sang khóa HKCU khác).
- Script chạy trong phiên PowerShell của người dùng (qua `iex`) nên **không dùng `exit`** (sẽ đóng cửa sổ): bọc trong `& { ... }` và dùng `return`.
- Web cần chuyển tiếp `/install.ps1` sang API (rewrite trong `apps/web/next.config.ts`; production do Caddy, M5.4).
