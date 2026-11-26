Endpoint cho CLI (`/agent/v1`, xác thực bằng device token).

- `POST /agent/v1/ingest` (M1.6): `ingest.controller.ts`, `ingest.service.ts`; đọc body gzip ở `ingest-body.ts`, validate ở `ingest-validator.ts`, khớp repo ở `repo-match.ts`, giới hạn tốc độ ở `rate-limiter.ts`.
- `GET /agent/v1/config` (M2.2): `agent-config.controller.ts`, `agent-config.service.ts`; đọc và ghép `settings` (`redaction_patterns`, `truncation`) ở `agent-config.ts`. `min_cli_version` lấy từ env `MIN_CLI_VERSION` (mặc định `0.1.0`), `consent_text_version` từ `consent/consent-text.ts`.
- Chưa làm: `POST /agent/v1/heartbeat` (M3.3).
