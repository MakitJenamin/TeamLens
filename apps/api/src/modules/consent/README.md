`consent-text.ts`: văn bản đồng ý và phiên bản hiện tại (nguồn duy nhất). `tl join` ghi bản đồng ý vào `consents`; ingest yêu cầu thiết bị có bản đồng ý chưa rút với phiên bản hiện tại (403 `consent_required`).

Còn lại task M3.7: `POST /agent/v1/consent` (đồng ý lại / rút đồng ý).
