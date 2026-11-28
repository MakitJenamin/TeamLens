Văn bản đồng ý hiện hành nằm ở bảng `settings`, khóa `consent_text` (`{ version, text }`), đọc qua `readConsentText(db)` / `ConsentTextService` (`consent-text.service.ts`). Đây là **nguồn duy nhất lúc chạy** từ M4.6. Leader sửa trên trang Quản trị (module `admin`). `consent-text.ts` chỉ còn là dữ liệu gốc cho migration `0010_consent_text.sql`, test và DB test. `tl join` ghi bản đồng ý vào `consents`; ingest yêu cầu thiết bị có bản đồng ý chưa rút với phiên bản hiện tại (403 `consent_required`).

### Đồng ý lại và rút đồng ý (M3.7, contract `consent.yaml`)

`GET`/`POST /agent/v1/consent` (device token). Code: `consent.controller.ts`, `consent.service.ts`, `consent-status.ts` (suy ra trạng thái, thuần, có test).

- `GET` trả văn bản và phiên bản hiện hành cùng `status` của thiết bị: `granted` (có bản chưa rút đúng phiên bản hiện hành, cùng điều kiện ingest chấp nhận), `outdated` (chỉ còn bản chưa rút ở phiên bản cũ), `revoked` (không còn bản nào chưa rút và đã từng rút, hoặc thiết bị đang `consent_revoked`), `none` (chưa từng có bản đồng ý).
- `POST` với `action: grant` (kèm `textVersion` và `backfill`): sai phiên bản thì `409 consent_outdated`; đúng thì thêm một dòng `consents` và đưa thiết bị đang `consent_revoked` về `online`. Nếu thiết bị đã có bản chưa rút đúng phiên bản hiện hành thì chỉ cập nhật `backfill` của bản đó, không thêm dòng.
- `POST` với `action: revoke`: đặt `revoked_at` cho mọi bản chưa rút của thiết bị và `devices.status = consent_revoked`. Ingest từ đó trả `403 consent_required`; heartbeat vẫn được nhận và giữ nguyên `consent_revoked`. Token và project membership không đổi nên đồng ý lại sau được; muốn thu hồi thiết bị thì `POST /agent/v1/logout`. Dữ liệu đã gửi vẫn nằm trên server theo retention.
- Chỉ tác động tới thiết bị của token đang dùng (thiết bị khác của cùng người không đổi). Cả hai hành động ghi audit `consent.grant` / `consent.revoke` (target là thiết bị).
- **Đổi văn bản bằng trang Quản trị** (`PATCH /api/v1/admin/settings`, phiên bản tự tăng). Sửa `CONSENT_TEXT_VERSION` trong `consent-text.ts` không đổi gì trên server đang chạy. Mỗi lần đổi, mọi thiết bị (kể cả của người khác trong nhóm) sẽ bị ingest từ chối cho tới khi chạy `tl consent` một lần. Văn bản hiện hành (phiên bản `2026-11-28.1`) nhắc đủ `tl pause`, `tl resume`, `tl consent`, `tl consent revoke`, `tl uninstall`, `tl logout`; thêm hoặc đổi lệnh thì sửa văn bản và tăng phiên bản.

### Dữ liệu của tôi (M4.5)

`my-data.controller.ts`, `my-data.service.ts` (cookie, cả leader và member, luôn lấy user từ phiên đăng nhập):
- `GET /api/v1/me/consents`: các bản đồng ý của mọi thiết bị của mình.
- `GET /api/v1/me/session-views`: ai đã xem session của mình. Đọc `audit_log` action `session.view`, phân trang cursor như `/api/v1/audit`.

**Hạn chế đã biết:** chưa tính `session.ai` và `profile.view`. Mỗi lần mở session có 2 dòng (`sessions` và `findings` cùng ghi). Lượt xem của session đã bị xóa không hiện, vì truy vấn dùng `innerJoin`.
