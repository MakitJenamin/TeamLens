Cài đặt server (M4.6), nhật ký audit cho leader (M4.5), xóa dữ liệu của một người (M5.6); gộp user (J.8) nằm ở module `projects`. Từ Mốc 1.5 không còn vai trò admin: mọi route ở đây chỉ dành cho leader.

## Cài đặt server (M4.6, contract `admin.yaml`)

`server-settings.controller.ts`, `server-settings.service.ts`, `server-settings.schemas.ts`.

- `GET /api/v1/admin/settings` trả pattern redaction, số ngày retention, văn bản đồng ý hiện hành, `affectedDevices` (số thiết bị sẽ phải đồng ý lại) và phiên bản `redactionPatternsVersion`, `retentionVersion` (`updated_at` của dòng `settings` tính bằng micro giây, `'0'` khi chưa có dòng).
- `PATCH /api/v1/admin/settings` nhận một hoặc nhiều phần:
  - `redactionPatterns` kèm `expectedRedactionPatternsVersion`: tối đa 50 pattern `{ id, regex, ... }`. Id `^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$`, đúng bằng nhãn CLI tạo ra (`kind_from_id` bỏ `_` hai đầu, id `_` thì CLI bỏ pattern). Audit `settings.redaction_patterns.update`.
  - `retentionDays` kèm `expectedRetentionVersion`: 7–730, hoặc `null` là giữ vô hạn. Audit `settings.retention.update`.
  - Phiên bản lệch thì 409 (`redaction_patterns_conflict`, `retention_conflict`) và cả request rollback. Dòng đã có thì khóa `FOR UPDATE` rồi so; chưa có (`'0'`) thì `INSERT ... ON CONFLICT DO NOTHING`, không chèn được là 409 (`writeVersioned`).
  - `consentText` kèm `expectedConsentVersion`: lệch phiên bản thì 409. Phiên bản tự tăng theo dạng `YYYY-MM-DD.N` (`nextConsentVersion`, ngày UTC). Audit `settings.consent_text.update`.
- `POST /api/v1/admin/settings/redaction-test`: thử pattern trên đoạn mẫu, không lưu. Che đúng như CLI nhưng chỉ với pattern này (không gồm rule có sẵn).
- **Khóa trong bảng `settings`:**
  - `redaction_patterns`: CLI đọc qua `GET /agent/v1/config`.
  - `retention_days`: không có dòng thì mặc định 90 (`DEFAULT_RETENTION_DAYS`), jsonb `null` là vô hạn. Job M5.5 đọc bằng `readRetentionDays` (module `retention`), phân biệt hai trường hợp này.
  - `consent_text`: đọc qua `consent/consent-text.service.ts`.
- **Kiểm regex:** `regex-validator.service.ts` gọi helper Rust `apps/api/tools/regex-validator`, cùng crate `regex` và `size_limit` 2 MiB với CLI, timeout 5 giây. Không log regex hay đoạn mẫu.
  - Helper sao chép quy tắc che của `cli/crates/tl-core/src/redact.rs` (`kind_from_id`, vòng lặp `Redactor::redact`: group `secret` không tham gia thì che cả chuỗi khớp, bỏ khớp rỗng, gộp vùng chồng nhau). Sửa quy tắc ở CLI thì sửa cả helper.
  - Pattern quá rộng: helper chạy pattern trên bộ văn bản thường (`NORMAL_TEXTS`: prompt, code, log, diff, JSON); che từ 20% số byte, hoặc trung bình cứ 40 byte có một vùng che, thì trả 400 `pattern_too_broad` (cả khi lưu lẫn khi thử).
  - Build: `pnpm --filter @teamlens/api build:regex-validator`. Đổi đường dẫn bằng `REGEX_VALIDATOR_BIN`.
  - Chưa có helper thì lưu hoặc thử pattern trả 503 `regex_validator_unavailable`. **`apps/api/Dockerfile` chưa build helper này.**

## Xóa dữ liệu của một người (M5.6, contract `admin.yaml`, operationId `eraseUser`)

`user-erase.controller.ts`, `user-erase.service.ts`. `DELETE /api/v1/admin/users/{userId}` trả `{ userId, sessions, devices }` (số session gồm cả session con).

- Một transaction: khóa `FOR UPDATE` các leader còn hoạt động (theo id) rồi tới user đích. Hai leader xóa nhau cùng lúc thì lệnh sau chờ rồi nhận 409, không deadlock.
- Thứ tự lỗi: không phải UUID, không tồn tại hoặc đã có `deleted_at` → 404; tự xóa mình → 400 `cannot_erase_self`; đích là leader cuối cùng → 409 `last_leader`.
- Xóa tay phần cascade không tới: ghi chú người đó viết (`notes.author_id` là SET NULL), kết quả AI trỏ tới session/finding của họ mà thiếu `subject_user_id`. Sau đó xóa dòng `users`; FK cascade lo phần còn lại (session, turn, finding, điểm, ghi chú và mục thư viện prompt trên session, thiết bị, đồng ý, thống kê tuần, kết quả AI, API key, token `tlp_`, thành viên project, phiên đăng nhập, `ingest_batches`).
- **Kết quả AI của leader về cả team** có `subject_user_id` là null nhưng nhắc tới người bị xóa trong nội dung nên cũng bị xóa (M6.9): `weekly_team` (B2, nêu tên và id thành viên) và `prompt_candidates` (C2, trích prompt kèm id người gõ), tìm theo id người đó trong `result`. **Chưa xử lý:** kết quả `skill_triage`, `skill_content`, `catalog_picks` của leader chạy trên cả team (dẫn xuất từ prompt nhiều người, không nêu id) vẫn còn tới khi leader chạy lại hoặc hết retention.
- Audit log giữ lại: `actor_id` của người bị xóa thành null, dòng có target là session của họ còn nguyên. Thêm dòng `user.erase` (target `user`), `metadata` chỉ có số đếm, không ghi tên hay email.
- Job `session.ingested` còn trong hàng đợi cho session đã xóa: `scoreSession` không thấy session thì bỏ qua, job vẫn completed.
- Web: nút "Xóa dữ liệu" ở tab Tài khoản (`admin/erase-user.tsx`), phải gõ đúng tên mới bật nút xóa.

## Nhật ký audit (M4.5)

`GET /api/v1/audit` (`audit.controller.ts`, `audit-query.service.ts`):
- Lọc theo `action`, `actorId`, `from`, `to`; phân trang cursor `at` + `id` (`audit-cursor.ts`, dùng chung với `/me/session-views` của module `consent`). Cursor giữ `at` dạng chuỗi Postgres in ra (đủ micro giây, cột `cursorAt` trong select) và so sánh `(at, id) < (...)` ngay trong SQL, không đi qua `Date` của JS (chỉ tới mili giây).
- **Lỗi đã biết:** cursor chỉ chính xác tới mili giây, trong khi `audit_log.at` chính xác tới micro giây, nên các dòng ghi cùng transaction có thể bị bỏ khi chuyển trang.
- Response chưa trả cột `details` (MCP ghi) hay `metadata` (M4.4, M4.6 ghi).
