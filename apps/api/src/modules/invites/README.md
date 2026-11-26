Link mời chung và tham gia bằng `tl join` (task J.3, SPEC 7.1; contract `packages/schema/openapi/invites.yaml`).

- `invites.controller.ts`: dashboard (`/api/v1/projects/:projectId/invites`, chỉ leader) và CLI công khai (`GET /agent/v1/invites/:code`, `POST /agent/v1/join`, 10 request/phút mỗi IP, tính chung).
- `invites.service.ts`: `join` chạy một transaction, `SELECT ... FOR UPDATE` dòng invite rồi kiểm tra lại; máy mới tạo user member + thiết bị + đồng ý, máy có token chỉ thêm vào project.
- `invite-factory.ts`: tạo link (dùng chung với wizard setup). `invite-status.ts`: tính `status`, lỗi 404/410.
