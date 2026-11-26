Xem session trên dashboard (spec 7.4, contract `packages/schema/openapi/sessions.yaml`).

- `GET /api/v1/projects/:projectId/sessions`: danh sách, sắp `startedAt` giảm dần rồi `id`, phân trang cursor (base64url của `{ startedAt đủ micro giây, id }`). Mặc định ẩn session con (`parent_session_id` hoặc `parent_source_id` khác null).
- `GET /api/v1/sessions/:sessionId`: chi tiết kèm turn theo `seq`; jsonb của turn lưu dạng session.v1 (snake_case) được đổi sang camelCase ở `session-mappers.ts`.
- Quyền đi qua `AccessService`: member chỉ thấy session của mình (lọc `userId` người khác → 403), leader thấy mọi session trong project mình dẫn, admin thấy tất cả. Xem chi tiết session của người khác ghi audit `session.view`.

Để sau: M3.4 (diff tô màu, session con lồng nhau, ghi chú), M4.1 (full-text search).
