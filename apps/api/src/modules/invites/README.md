Link mời chung và tham gia bằng `tl join` (task J.3, SPEC 7.1; contract `packages/schema/openapi/invites.yaml`).

- `invites.controller.ts`: dashboard (`/api/v1/projects/:projectId/invites`, chỉ leader) và CLI công khai (`GET /agent/v1/invites/:code`, `POST /agent/v1/join`, 10 request/phút mỗi IP, tính chung).
- `invites.service.ts`: `join` chạy một transaction, `SELECT ... FOR UPDATE` dòng invite rồi kiểm tra lại; máy mới tạo user member + thiết bị + đồng ý, máy có token chỉ thêm vào project.
- `invite-factory.ts`: tạo link (dùng chung với wizard setup). `invite-status.ts`: tính `status`, lỗi 404/410.

### Script cài đặt `GET /install.ps1` (M3.6)

`irm <server>/install.ps1?code=<mã> | iex` (contract `invites.yaml`). Code: `InstallScriptController` trong `invites.controller.ts`, script sinh ở `install-script.ts` (thuần, có test).

- Công khai, cùng bộ đếm 10 request/phút mỗi IP với xem trước và join. Trả `text/plain; charset=utf-8`, `Cache-Control: no-store`.
- Chỉ kiểm tra **định dạng** mã (`INVITE_CODE_RE`, chỉ gồm `A-Za-z0-9_-`); sai thì `404 invite_not_found` dạng JSON. **Không** kiểm tra link còn dùng được (việc của `tl join`, qua `GET /agent/v1/invites/:code`). Địa chỉ server (`TEAMLENS_PUBLIC_URL`) được thoát nháy đơn khi nhúng, nên không có đường nhúng lệnh lạ vào script.
- **Phạm vi M3.6 là bản tối thiểu:** script tìm `tl.exe` (PATH hoặc `%LOCALAPPDATA%\teamlens\bin\tl.exe`) rồi chạy `tl join <server>/i/<mã>`; chưa có `tl.exe` thì báo rõ và dừng. **Phần tải `tl.exe` từ GitHub Releases, kiểm SHA-256, đặt vào thư mục và thêm PATH là M5.2** (Người 1): chèn vào chỗ có ghi chú "M5.2" trong `install-script.ts`, đừng viết endpoint thứ hai.
- Script chạy trong phiên PowerShell của người dùng (qua `iex`) nên **không dùng `exit`** (sẽ đóng cửa sổ): bọc trong `& { ... }` và dùng `return`.
- Web cần chuyển tiếp `/install.ps1` sang API (rewrite trong `apps/web/next.config.ts`; production do Caddy, M5.4).
