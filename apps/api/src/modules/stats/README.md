Thống kê tuần (M2.8). M2.9, M2.10, M4.3 (tổng quan, hồ sơ, leaderboard) đọc bảng `user_weekly_stats` thay vì tự tính lại.

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
