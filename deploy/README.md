# Cài TeamLens server (self-host)

Bốn container chạy bằng Docker Compose (SPEC 11.3): `api` (NestJS, kèm worker chấm điểm), `web` (dashboard Next.js), `postgres` (Postgres 16) và `caddy` (reverse proxy, tự xin HTTPS Let's Encrypt). Chỉ Caddy mở cổng ra ngoài.

| File | Nội dung |
| --- | --- |
| `docker-compose.yml` | Bản production |
| `Caddyfile` | `/api/*`, `/agent/*`, `/health` → API; còn lại → web |
| `.env.example` | Mẫu cấu hình, sao chép thành `.env` |
| `docker-compose.dev.yml` | Chỉ Postgres cho phát triển (`pnpm db:up`), không dùng khi cài thật |
| `install.ps1`, `install.cmd` | Script cài `tl` trên máy thành viên (đính kèm vào GitHub Release) |

## Yêu cầu

- Máy Linux có Docker Engine 24+ và plugin Compose v2 (`docker compose version`). Cấu hình tối thiểu cho team 20 người: 2 vCPU, 4 GB RAM, 40 GB SSD.
- Một tên miền (vd. `teamlens.congty.com`) có bản ghi DNS A/AAAA trỏ về máy.
- Cổng 80 và 443 mở ra Internet (Let's Encrypt cần cổng 80 để cấp chứng chỉ).
- Máy chủ ra được GitHub (thành viên tải `tl` từ GitHub Releases, không qua server).

## Cài đặt (khoảng 10 phút)

```bash
git clone https://github.com/MakitJenamin/TeamLens.git teamlens && cd teamlens
cp deploy/.env.example deploy/.env
# Sửa deploy/.env: TEAMLENS_DOMAIN, POSTGRES_PASSWORD, TEAMLENS_SECRET_KEY
#   POSTGRES_PASSWORD:   openssl rand -hex 24
#   TEAMLENS_SECRET_KEY: openssl rand -base64 32
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps   # cả 4 container "healthy"/"running"
```

Lần đầu build image mất vài phút. Khi `api` khởi động, nó tự chạy migration DB rồi mới nhận request.

Mở `https://<TEAMLENS_DOMAIN>`, trình duyệt chuyển tới wizard `/setup`: tạo tài khoản leader, project đầu tiên và repo pattern, rồi nhận **link mời**. Gửi link cho nhóm; mỗi người cài `tl` bằng lệnh hiện trên trang link mời rồi chạy `tl join <link>`.

## Vận hành

Các lệnh dưới đây chạy ở gốc repo; đặt `alias tlc='docker compose -f deploy/docker-compose.yml --env-file deploy/.env'` cho gọn.

| Việc | Lệnh |
| --- | --- |
| Xem log | `tlc logs -f api` (hoặc `web`, `caddy`) |
| Cập nhật lên bản mới | `git pull && tlc up -d --build` (migration tự chạy khi `api` khởi động) |
| Dừng / chạy lại | `tlc stop` / `tlc start` |
| Sao lưu DB | `tlc exec -T postgres pg_dump -U teamlens -Fc teamlens > teamlens-$(date +%F).dump` |
| Khôi phục DB | `tlc exec -T postgres pg_restore -U teamlens -d teamlens --clean --if-exists < teamlens-YYYY-MM-DD.dump` |

- Sao lưu DB định kỳ (cron hằng ngày) và giữ `deploy/.env` cùng bản sao lưu: `TEAMLENS_SECRET_KEY` mã hóa API key AI của từng người, mất khóa thì mọi người phải nhập lại key.
- Dữ liệu nằm ở volume `teamlens_postgres-data`; chứng chỉ HTTPS ở `teamlens_caddy-data`. `tlc down` giữ volume; `tlc down -v` **xóa sạch dữ liệu**.

## Bảo mật

- **Không mở thẳng cổng `api` (3001) hay `web` (3000) ra ngoài.** Hai service này tin header `X-Forwarded-For` từ mạng nội bộ để giới hạn tần suất link mời theo IP; Caddy ghi đè header này bằng IP thật của client, còn ai gọi thẳng vào cổng nội bộ thì giả được IP. Compose mặc định không publish hai cổng này, đừng thêm `ports:` cho chúng.
- Postgres cũng chỉ nằm trong mạng nội bộ; muốn truy cập thì dùng `tlc exec postgres psql -U teamlens teamlens`.
- Cookie đăng nhập có cờ `Secure` khi `TEAMLENS_PUBLIC_URL` là `https://`.

## Thử trên máy (không cần tên miền)

Đặt trong `deploy/.env`: `TEAMLENS_DOMAIN=localhost`, `TEAMLENS_PUBLIC_URL=https://localhost:8443`, `HTTP_PORT=8080`, `HTTPS_PORT=8443`, rồi `up -d --build` như trên và mở `https://localhost:8443` (Caddy dùng chứng chỉ nội bộ, trình duyệt sẽ cảnh báo). CLI `tl` không tin chứng chỉ nội bộ này, nên chỉ thử được `tl join` với tên miền thật.

## Gặp lỗi

- `caddy` không lấy được chứng chỉ: kiểm tra DNS trỏ đúng máy và cổng 80/443 mở (`tlc logs caddy`).
- `api` không lên: `tlc logs api`; thường do thiếu/sai biến trong `deploy/.env` (API báo rõ biến nào) hoặc Postgres chưa sẵn sàng.
- Đổi `POSTGRES_PASSWORD` sau khi đã cài không có tác dụng với DB đã tạo; đổi mật khẩu bằng `ALTER USER` trong Postgres rồi mới sửa `.env`.

## Hạn chế đã biết

- **Pattern redaction riêng (trang Quản trị, M4.6) chưa lưu được trên bản Docker.** Server kiểm pattern bằng helper Rust `apps/api/tools/regex-validator`, nhưng `apps/api/Dockerfile` chưa build helper này, nên lưu hoặc thử pattern trả lỗi 503 `regex_validator_unavailable`. Cài đặt khác (retention, văn bản đồng ý) vẫn dùng được. Khi sửa Dockerfile thì thêm bước build helper và đặt `REGEX_VALIDATOR_BIN` trỏ tới file đó trong image.

## Khi nào phải sửa file Docker

Code mới, thư viện mới (`pnpm-lock.yaml`) và migration mới tự vào image khi `up -d --build`. Chỉ phải sửa khi:
- **Thêm biến môi trường** vào `apps/api/src/config/env.ts`: thêm vào `environment` của service trong `docker-compose.yml` và `.env.example`.
- **Thêm workspace package** mà api hoặc web dùng: thêm dòng `COPY` trong Dockerfile.
- **Thêm service** (Redis...) hoặc **prefix route mới** ngoài `/api`, `/agent`, `/health` mà phải đi thẳng sang API: sửa compose hoặc `Caddyfile`.
- **Code đọc file ngoài `dist/` lúc chạy**, hoặc cần thêm binary (như `regex-validator`): đưa vào image ở bước build.
