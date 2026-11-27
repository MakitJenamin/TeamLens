`consent-text.ts`: văn bản đồng ý và phiên bản hiện tại (nguồn duy nhất). `tl join` ghi bản đồng ý vào `consents`; ingest yêu cầu thiết bị có bản đồng ý chưa rút với phiên bản hiện tại (403 `consent_required`).

### Đồng ý lại và rút đồng ý (M3.7, contract `consent.yaml`)

`GET`/`POST /agent/v1/consent` (device token). Code: `consent.controller.ts`, `consent.service.ts`, `consent-status.ts` (suy ra trạng thái, thuần, có test).

- `GET` trả văn bản và phiên bản hiện hành cùng `status` của thiết bị: `granted` (có bản chưa rút đúng phiên bản hiện hành, cùng điều kiện ingest chấp nhận), `outdated` (chỉ còn bản chưa rút ở phiên bản cũ), `revoked` (không còn bản nào chưa rút và đã từng rút, hoặc thiết bị đang `consent_revoked`), `none` (chưa từng có bản đồng ý).
- `POST` với `action: grant` (kèm `textVersion` và `backfill`): sai phiên bản thì `409 consent_outdated`; đúng thì thêm một dòng `consents` và đưa thiết bị đang `consent_revoked` về `online`. Nếu thiết bị đã có bản chưa rút đúng phiên bản hiện hành thì chỉ cập nhật `backfill` của bản đó, không thêm dòng.
- `POST` với `action: revoke`: đặt `revoked_at` cho mọi bản chưa rút của thiết bị và `devices.status = consent_revoked`. Ingest từ đó trả `403 consent_required`; heartbeat vẫn được nhận và giữ nguyên `consent_revoked`. Token và project membership không đổi nên đồng ý lại sau được; muốn thu hồi thiết bị thì `POST /agent/v1/logout`. Dữ liệu đã gửi vẫn nằm trên server theo retention.
- Chỉ tác động tới thiết bị của token đang dùng (thiết bị khác của cùng người không đổi). Cả hai hành động ghi audit `consent.grant` / `consent.revoke` (target là thiết bị).
- **Đổi nội dung văn bản thì phải tăng `CONSENT_TEXT_VERSION`**, và mọi thiết bị (kể cả của người khác trong nhóm) sẽ bị ingest từ chối cho tới khi chạy `tl consent` một lần. Văn bản còn ghi `tl consent revoke` là "sẽ có ở bản sau": chỉ cập nhật và tăng phiên bản sau khi CLI có `tl consent` (xem `docs/TASKS.md` M3.7).
