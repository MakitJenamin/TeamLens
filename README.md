# TeamLens

Công cụ open-source, tự host, giúp leader xem thành viên trong team làm việc với AI coding agent (Claude Code, Codex, Copilot, ...) như thế nào: prompt gì, prompt ra sao, mắc anti-pattern nào, và kỹ năng tiến bộ ra sao theo thời gian.

- **CLI `tl`** (Rust) chạy nền trên máy thành viên, đọc log của agent, chỉ lấy session thuộc repo của dự án, che secret rồi gửi lên server.
- **Server** (NestJS + Postgres) chấm điểm bằng rule, chấm thêm bằng LLM khi bấm nút.
- **Web dashboard** (Next.js) cho leader và thành viên.

Trạng thái: đang ở giai đoạn đặc tả. Xem [docs/SPEC.md](docs/SPEC.md).

License: AGPL-3.0 (dự kiến).
