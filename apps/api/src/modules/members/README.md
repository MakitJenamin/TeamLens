Trang Thành viên của dashboard (M4.2, Người 1; SPEC 7.1 và bảng trang dashboard; contract `packages/schema/openapi/members.yaml`).

- `GET /api/v1/projects/:projectId/member-status` (chỉ leader, `@LeaderOnly()`): thành viên của project kèm `joinedAt` (`project_members.created_at`), `lastSessionAt` (`max(started_at)` session của họ trong project) và mọi thiết bị (kể cả đã thu hồi).
- `devices[].status` là trạng thái hiệu lực qua `effectiveDeviceStatus` (`agent/heartbeat.ts`): không đọc thẳng `devices.status` vì "offline" chỉ tính khi đọc.
- Ba truy vấn cố định (project, thành viên + session gần nhất, thiết bị), ghép bằng hàm thuần `buildMemberStatus` (`member-status.ts`, có test).
- Không ghi audit: chỉ là metadata, giống `listProjectMembers`.
- Hành động trên trang dùng endpoint có sẵn: thu hồi thiết bị (`device`), xóa khỏi project (`projects`), gộp user (`projects/user-merge.service.ts`).
