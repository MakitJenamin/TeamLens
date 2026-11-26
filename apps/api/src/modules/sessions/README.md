Xem session trên dashboard (spec 7.4, contract `packages/schema/openapi/sessions.yaml`).

- `GET /api/v1/projects/:projectId/sessions`: danh sách, sắp `startedAt` giảm dần rồi `id`, phân trang cursor (base64url của `{ startedAt đủ micro giây, id }`). Mặc định ẩn session con (`parent_session_id` hoặc `parent_source_id` khác null).
- `GET /api/v1/sessions/:sessionId`: chi tiết kèm turn theo `seq`; jsonb của turn lưu dạng session.v1 (snake_case) được đổi sang camelCase ở `session-mappers.ts`.
- `GET /api/v1/sessions/:sessionId` còn trả `children` (session con rút gọn: `sourceId`, tiêu đề, số turn) để web ghép session con vào turn tool `Task`/`Agent`; danh sách có `childCount`.
- Ghi chú theo turn (M3.4, `session-notes.service.ts`): `GET/POST /api/v1/sessions/:sessionId/notes`, `DELETE .../notes/:noteId`. Ai xem được session thì đọc được ghi chú (không audit riêng); chỉ leader tạo (`turnSeq` phải là turn có thật, null = ghi chú chung), chỉ tác giả xóa; tạo/xóa ghi audit `session.note.create`/`session.note.delete`.
- Quyền đi qua `AccessService`: member chỉ thấy session của mình (lọc `userId` người khác → 403), leader thấy mọi session trong project mình dẫn, admin thấy tất cả. Xem chi tiết session của người khác ghi audit `session.view`.

Để sau: M4.1 (full-text search).
