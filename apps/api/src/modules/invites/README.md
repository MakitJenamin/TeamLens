Link mời chung và tham gia bằng `tl join` (task J.3, SPEC 7.1; contract `packages/schema/openapi/invites.yaml`).

- `invites.controller.ts`: dashboard (`/api/v1/projects/:projectId/invites`, chỉ leader) và CLI công khai (`GET /agent/v1/invites/:code`, `POST /agent/v1/join`, 10 request/phút mỗi IP, tính chung).
- `invites.service.ts`: `join` chạy một transaction, `SELECT ... FOR UPDATE` dòng invite rồi kiểm tra lại; máy mới tạo user member + thiết bị + đồng ý, máy có token chỉ thêm vào project.
- `invite-factory.ts`: tạo link (dùng chung với wizard setup). `invite-status.ts`: tính `status`, lỗi 404/410.

### Lệnh cài `tl` (`installCommand`)

Server **không** phục vụ script cài nữa (`GET /install.ps1?code=` của M3.6/M5.2 đã gỡ). `installCommand` trong response tạo link mời giữ nguyên tên/kiểu trong contract, giá trị là lệnh PowerShell cài `tl` chung, không kèm mã mời (`INSTALL_COMMAND` trong `invite-status.ts`):

```powershell
irm https://github.com/MakitJenamin/TeamLens/releases/latest/download/install.ps1 | iex
```

Script là asset `install.ps1` (và `install.cmd` cho CMD) của GitHub Releases, nguồn ở `deploy/`: chỉ tải `SHA256SUMS` + `tl-x86_64-pc-windows-msvc.zip`, kiểm SHA-256, cài `%LOCALAPPDATA%	eamlensin	l.exe` và thêm PATH user. Tham gia nhóm là bước riêng: `tl join <server>/i/<mã>`.
