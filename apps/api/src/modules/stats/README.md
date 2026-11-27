Thống kê tuần (M2.8) và tổng quan project (M2.9). M2.9, M2.10, M4.3 (tổng quan, hồ sơ, leaderboard) đọc bảng `user_weekly_stats` thay vì tự tính lại.

- `weekly-stats.ts`: hàm thuần `computeWeeklyScores` (điểm 5 nhóm của một tuần) cùng hằng `CATEGORIES`, `PENALTIES` dùng chung với `rules/score-session.ts`.
- `refresh-weekly-stats.ts`: `refreshWeeklyStats(tx, ...)` tính lại một dòng `user_weekly_stats`; `weekWindow(date)` cho tuần UTC (thứ Hai 00:00 tới thứ Hai kế tiếp). Được gọi cuối `scoreSession`, trong cùng transaction và advisory lock của tuần.

Một dòng = một người, một project, một tuần (`week` là ngày thứ Hai):

| Cột | Ý nghĩa |
| --- | --- |
| `sessions` | Số session **gốc** bắt đầu trong tuần. Session con không tính. |
| `tokens` | `input + output + cache đọc + cache ghi` của **mọi** session trong tuần, kể cả session con (chi phí thật của người đó). |
| `scores` | JSON `{ prompt_quality, context, correction_loop, session_management, verification }`, mỗi nhóm 0–100. `{}` khi tuần chưa có session nào được chấm. |

Cách tính `scores` mỗi nhóm: trung bình điểm các session gốc, trọng số là `turn_count` (nếu mọi session đều 0 turn thì chia đều), **rồi trừ** điểm phạt của finding phạm vi `user_week` cùng nhóm trong tuần (low 5, medium 10, high 20), tối thiểu 0, làm tròn. Điểm session chỉ dùng rule phạm vi session nên finding tuần không bị trừ hai lần.

Dòng bị xóa khi tuần không còn session nào. Khi retention đã xóa turn của session, điểm và thống kê cũ được giữ.

### Tổng quan project (M2.9)

`GET /api/v1/projects/{projectId}/overview?from=&to=` (chỉ leader, mọi project; contract `stats.yaml`). Code: `overview.controller.ts`, `overview.service.ts` (truy vấn), `overview-math.ts` (tính thuần, có test), `pricing.ts` (bảng giá).

- Khoảng thời gian làm tròn ra tuần UTC (`from` xuống, `to` lên), mặc định 8 tuần gần nhất gồm tuần hiện tại, tối đa 53 tuần. Tuần không có dữ liệu vẫn có mặt với số 0.
- Số session, token và điểm theo tuần lấy từ `user_weekly_stats` (M2.8). Điểm tuần của project là trung bình điểm tuần từng thành viên, trọng số là số session của họ trong tuần.
- Phân bố agent lấy từ `sessions`; phân bố model, chi phí và các số liệu không tính điểm lấy từ `turns` (chỉ lượt `assistant`), nên chỉ có khi turn còn trong retention.
- **Chi phí là ước tính** từ `pricing.ts` (USD / 1 triệu token theo model, khớp theo tiền tố tên model). Không phải hóa đơn; nhà cung cấp đổi giá thì sửa file đó. Model chưa có giá không tính vào chi phí (`estimatedCostUsd = null` ở dòng model đó). Không còn turn nào của kỳ thì chi phí kỳ đó là `null`.
- **`usageStats` không tính điểm**, không vào điểm hay leaderboard (RULES.md mục 2): `cacheHitRate` = cache đọc / (input + cache đọc + cache ghi); `premiumModelRate` = tỉ lệ lượt dùng model cao cấp (cờ `premium` trong `pricing.ts`, trên các lượt có ghi model); `highReasoningRate` = tỉ lệ lượt `reasoning_effort` là `high`/`xhigh` trên các lượt có ghi mức suy luận; `avgOutputTokensPerTurn` = output trung bình mỗi lượt assistant.
- `topFindings`: tối đa 10 rule, theo số finding giảm dần, kèm số thành viên mắc. Gồm cả finding tuần.
- Bảng trạng thái thành viên (online, offline, tạm dừng...) không nằm ở đây; thuộc trang Thành viên (M4.2).

### Hồ sơ thành viên (M2.10)

`GET /api/v1/users/{userId}/profile?project=&from=&to=` (contract `stats.yaml`). Code: `profile.controller.ts`, `profile.service.ts` (quyền, audit, truy vấn), `profile-math.ts` (tính thuần, có test).

- **Quyền:** leader xem được mọi thành viên của project và **ghi audit `profile.view`** (đoạn trích prompt là nội dung riêng); member chỉ xem của mình (xem người khác `403`, không ghi audit khi xem của chính mình). `404` khi project không tồn tại hoặc user không thuộc project; `400` khi thiếu `project`.
- **Khoảng thời gian:** mặc định **2 tuần** gần nhất (gồm tuần hiện tại), làm tròn ra tuần UTC như tổng quan; giao diện cho chọn 2/4/8/12/26 tuần. Docs không yêu cầu số tuần nào, đây là lựa chọn của Người 2.
- `scores` (radar) = trung bình điểm tuần của thành viên, trọng số là số session mỗi tuần. `teamScores` = trung bình điểm tuần của **mọi thành viên project** cùng khoảng (cùng trọng số), mỗi tuần trong `weeks` cũng có `teamScores`. **`teamScores` hiện cho cả leader lẫn member, không ẩn.** Đã cân nhắc: team rất nhỏ (2 người) thì member có thể suy ra điểm người kia; quyết định chấp nhận, nếu cần giới hạn thì chỉ đổi ở `profile.service.ts`.
- `patterns`: tối đa 10 rule thành viên vi phạm nhiều nhất trong khoảng (gộp theo rule, mức độ lấy mức nặng nhất đã gặp, gồm cả finding tuần). `advice` lấy từ `rules.definition.advice`. Mỗi rule tối đa 3 ví dụ mới nhất (`turnSeq`, nhận xét, `excerpt` tối đa 160 ký tự lấy từ turn còn lưu, `null` khi retention đã xóa turn).
- Danh sách session gần nhất của thành viên không có endpoint riêng: web gọi `GET /projects/{id}/sessions?userId=`.
