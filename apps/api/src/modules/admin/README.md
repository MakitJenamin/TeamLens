Cài đặt server (M4.6), nhật ký audit cho leader (M4.5), gộp user (J.8). Còn M5.6 (xóa dữ liệu của một người). Từ Mốc 1.5 không còn vai trò admin: mọi route ở đây chỉ dành cho leader.

## Cài đặt server (M4.6, contract `admin.yaml`)

`server-settings.controller.ts`, `server-settings.service.ts`, `server-settings.schemas.ts`.

- `GET /api/v1/admin/settings` trả pattern redaction, số ngày retention, văn bản đồng ý hiện hành và `affectedDevices` (số thiết bị sẽ phải đồng ý lại).
- `PATCH /api/v1/admin/settings` nhận một hoặc nhiều phần:
  - `redactionPatterns`: tối đa 50 pattern `{ id, regex, ... }`, id `^[a-z0-9_]+$`. Audit `settings.redaction_patterns.update`.
  - `retentionDays`: 7–730, hoặc `null` là giữ vô hạn. Audit `settings.retention.update`.
  - `consentText` kèm `expectedConsentVersion`: lệch phiên bản thì 409. Phiên bản tự tăng theo dạng `YYYY-MM-DD.N` (`nextConsentVersion`, ngày UTC). Audit `settings.consent_text.update`.
- `POST /api/v1/admin/settings/redaction-test`: thử pattern trên đoạn mẫu, không lưu.
- **Khóa trong bảng `settings`:**
  - `redaction_patterns`: CLI đọc qua `GET /agent/v1/config`.
  - `retention_days`: không có dòng thì mặc định 90 (`DEFAULT_RETENTION_DAYS`), jsonb `null` là vô hạn. Job M5.5 phải phân biệt hai trường hợp này.
  - `consent_text`: đọc qua `consent/consent-text.service.ts`.
- **Kiểm regex:** `regex-validator.service.ts` gọi helper Rust `apps/api/tools/regex-validator`, cùng crate `regex` và `size_limit` 2 MiB với CLI, timeout 5 giây. Không log regex hay đoạn mẫu.
  - Build: `pnpm --filter @teamlens/api build:regex-validator`. Đổi đường dẫn bằng `REGEX_VALIDATOR_BIN`.
  - Chưa có helper thì lưu hoặc thử pattern trả 503 `regex_validator_unavailable`. **`apps/api/Dockerfile` chưa build helper này.**

## Nhật ký audit (M4.5)

`GET /api/v1/audit` (`audit.controller.ts`, `audit-query.service.ts`):
- Lọc theo `action`, `actorId`, `from`, `to`; phân trang cursor `at` + `id` (`audit-cursor.ts`, dùng chung với `/me/session-views` của module `consent`).
- **Lỗi đã biết:** cursor chỉ chính xác tới mili giây, trong khi `audit_log.at` chính xác tới micro giây, nên các dòng ghi cùng transaction có thể bị bỏ khi chuyển trang.
- Response chưa trả cột `details` (MCP ghi) hay `metadata` (M4.4, M4.6 ghi).
