`evaluateSession(session, sessionRules)` chấm session gốc theo thứ tự `seq`. Truyền `parentSourceId` và các turn đã chuẩn hóa, đã che secret. Kết quả chứa khóa rule, mức độ, số đếm và bằng chứng để worker M1.11 lưu.

Ba rule M1.10 cùng các ca test nội tuyến nằm trong `session-rules.ts`. Theo RULES.md, `no-test-after-edit` tìm lệnh kiểm chứng trong toàn bộ session. Chạy `pnpm --filter @teamlens/api test` để kiểm tra.

M2.7 bổ sung 10 rule trong `additional-rules.ts` và 3 rule tuần trong `weekly-rules.ts`. Bộ 16 rule high/medium gồm 13 rule chấm từng session và 3 rule tổng hợp session gốc của cùng người, cùng project, từ thứ Hai 00:00 UTC đến trước thứ Hai kế tiếp.

Ví dụ, `lazy-prompting` cần ít nhất 10 prompt có nội dung và chỉ cảnh báo khi hơn 30% ngắn dưới 30 ký tự. Mỗi rule tuần tạo tối đa một finding, gắn vào session có nhiều lượt vi phạm nhất. Bằng chứng lưu tuần, số lượt vi phạm, mẫu số và tỉ lệ để kiểm tra lại. Điểm của từng session chỉ dùng các rule phạm vi session.

API đăng ký worker `session.ingested` sau khi hàng đợi khởi động. Worker và lệnh dev dùng chung giao dịch chấm điểm. Chạy `pnpm --filter @teamlens/api rules:run` để tính lại trên DB đã migrate và seed; thêm `--session <UUID>` để chọn một session. Session con không có điểm. Khi retention đã xóa turn, các điểm đã tính được giữ lại.

Truy vấn findings nằm ở `FindingsService` (M6.15, tách khỏi controller để tool MCP `get_findings` dùng lại cùng quyền và audit); rule đọc qua `RulesQueryService` (chỉ đọc, rule riêng của project ghi đè rule mặc định cùng khóa; M4.4 dùng lại cho danh sách rule). `RulesWriteService` (M6.16, `rules-write.service.ts` và `rule-definition.ts`) là phần ghi cho tool MCP của leader: soạn thử, chạy thử trên 50 session, lưu bản riêng của project, bật/tắt; chỉ chỉnh ngưỡng, mức độ, thông điệp, lời khuyên của rule **session có sẵn** (không đổi `match`, không tạo rule mới), từ chối khi `tests` nội tuyến không còn đúng, audit kèm giá trị cũ và mới, phát job `project.rescore`. Chi tiết ở `mcp/README.md`; M4.4 dùng lại hoặc mở rộng. Các service này được export cho module `mcp`.

`GET /api/v1/sessions/{sessionId}/findings` dùng cookie dashboard và cùng quyền xem với trang session. Đoạn trích lấy từ turn còn được lưu; khi turn hết hạn, trường `evidenceExcerpt` trả về `null`.

### Dữ liệu mẫu để thử chấm điểm (M2.6)

Trên DB dev đã migrate, chạy lần lượt:

```sh
pnpm --filter @teamlens/api db:seed
pnpm --filter @teamlens/api rules:seed
pnpm --filter @teamlens/api rules:run
```

`rules:seed` dùng hai tài khoản member của seed chung trong project TeamLens. Lọc các session bằng nhánh `demo/scoring` hoặc tiền tố source ID `scoring-demo:v1:`. Có 6 session mỗi người mỗi tuần, trong 3 tuần UTC đã kết thúc. Member 1 chuyển sang phiên đối chứng ở tuần cuối; member 2 có chiều ngược lại. Chạy lại giữ nguyên ID, thay các turn mẫu và căn lại ngày theo tuần đang chạy.

| Kiểu phiên | Số phiên | Tín hiệu có thể kiểm tra |
| --- | ---: | --- |
| Phiên dài | 3 | Prompt ngắn, lặp, phản bác liên tiếp, ngắt lượt, câu hỏi tra cứu, log dài, file hướng dẫn lớn, lệnh test lỗi lặp lại, vòng tool dài, diff đảo ngược, compaction và shell ở chế độ bypass. |
| Sửa thiếu kiểm chứng | 15 | Thiếu hướng dẫn, prompt đầu mơ hồ, ít prompt nhưng diff cuối 500 dòng, phản hồi nhanh sau diff và thiếu test. |
| Phiên đối chứng | 18 | Có file hướng dẫn, prompt nhắc spec, nêu tiêu chí, chạy test và xem lại kết quả. |

Với ba rule M1.10 mặc định, riêng bộ mẫu cho **3** finding `mega-session`, **3** `repeated-correction` và **15** `no-test-after-edit`. Các tín hiệu khác dùng cho rule ở mốc sau. Với rule chi phí, dùng `claude-opus-4-6` làm model cao cấp khi thử.

### Điểm tuần và chạy lại (M2.8)

Sau mỗi lần chấm một session (kể cả session con, vì token của nó cộng vào tuần), `scoreSession` cập nhật `user_weekly_stats` của tuần đó; cách tính nằm ở `modules/stats/README.md`. Finding tuần trừ vào điểm tuần theo nhóm của rule.

`POST /api/v1/projects/{projectId}/rules/rerun` (chỉ leader, ghi audit `rules.rerun`) trả `202 { "status": "queued" }` rồi chấm lại **mọi session của project ở nền** bằng job pg-boss `project.rescore` (`rescoreProject` trong `score-session.ts`, duyệt theo lô 100 session). Chạy lại nhiều lần không tạo bản ghi trùng. Nút "Chạy lại" trên UI (M4.4) gọi chính endpoint này. Lệnh dev tương đương cho cả DB: `pnpm --filter @teamlens/api rules:run`.

## Quản lý rule theo project (M4.4, contract `rules.yaml`)

`rule-config.controller.ts`, `rule-config.service.ts`, `rescore.service.ts`; mọi route chỉ leader.

| Route | Việc |
| --- | --- |
| `GET /api/v1/projects/{id}/rules` | Rule hiệu lực (bản riêng ghi đè bản mặc định), kèm `needsRerun` |
| `PATCH /rules/{key}` | Bật/tắt, mức độ, ngưỡng; tạo hoặc cập nhật bản riêng; audit `rules.update` (cột `metadata`) |
| `DELETE /rules/{key}/override` | Khôi phục mặc định rồi chấm lại (202); audit `rules.restore` |
| `POST /rules/{key}/test` | Thử trên 50 session gốc gần nhất; audit `rules.test` |
| `POST /rules/rerun`, `GET /rules/rerun/status` | Chạy lại có theo dõi, xem tiến độ |

- **Theo dõi lần chạy:** bảng `project_rescore_runs` (migration `0009`) với trạng thái `queued` → `running` → `succeeded`/`failed`. Unique index một phần đảm bảo mỗi project chỉ có một lần đang chạy, chạy trùng trả 409. Lần chạy `queued`/`running` quá 1 giờ được đánh `failed` (`rescore_stale`) khi có lần chạy mới. Job `project.rescore` nhận thêm `runId`; không có `runId` (tool MCP) thì chạy như cũ và không tạo dòng.
- **8 rule mức low:**
  - Session: `vague-followup`, `instruction-bloat`, `pasted-long-log` (`additional-rules.ts`).
  - Tuần: `no-spec-first`, `low-constraint-usage`, `no-file-context`, `high-interruption`, `premium-for-trivial` (`weekly-rules.ts`).
- **Lỗi đã biết (review 2026-11-28, chi tiết ở `docs/TASKS.md`):**
  - `high-interruption` đếm cờ ngắt trên prompt, trong khi CLI gắn cờ này cho turn assistant.
  - `restore` xóa dòng `rules`, nên finding cũ bị cascade xóa.
  - Lần chạy kẹt ở `running` không gỡ được từ UI.
  - `needsRerun` so với `finishedAt` thay vì `startedAt`.
  - `PATCH` kiểm test nội tuyến trên bản mặc định, không khóa dòng, và đánh phiên bản khác `RulesWriteService`.
  - `test` không bỏ session đã bị retention xóa turn.
