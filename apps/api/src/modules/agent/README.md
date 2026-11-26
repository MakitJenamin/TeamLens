Endpoint cho CLI (`/agent/v1`, xác thực bằng device token).

- `POST /agent/v1/ingest` (M1.6): `ingest.controller.ts`, `ingest.service.ts`; đọc body gzip ở `ingest-body.ts`, validate ở `ingest-validator.ts`, khớp repo ở `repo-match.ts`, giới hạn tốc độ ở `rate-limiter.ts`.
- Chưa làm: `GET /agent/v1/config` (M2.2), `POST /agent/v1/heartbeat` (M3.3).
