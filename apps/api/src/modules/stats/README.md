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

`GET /api/v1/projects/{projectId}/overview?from=&to=` (chỉ leader, mọi project; contract `stats.yaml`). `workTypes` (M6.7) đếm session gốc trong khoảng theo nhãn loại việc B4, chưa phân loại là `workType: null` (`sortWorkTypes` trong `overview-math.ts`). Code: `overview.controller.ts`, `overview.service.ts` (truy vấn), `overview-math.ts` (tính thuần, có test), `pricing.ts` (bảng giá).

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
- `patterns`: tối đa 10 rule thành viên vi phạm nhiều nhất trong khoảng (gộp theo rule, mức độ lấy mức nặng nhất đã gặp, gồm cả finding tuần). `advice` lấy từ `rules.definition.advice`. Mỗi rule tối đa 3 ví dụ mới nhất (`turnSeq`, nhận xét, `excerpt` tối đa 160 ký tự lấy từ turn còn lưu; `null` khi retention đã xóa turn **hoặc khi turn không có văn bản** như compaction).
- Danh sách session gần nhất của thành viên không có endpoint riêng: web gọi `GET /projects/{id}/sessions?userId=`.

## Leaderboard (M4.3)

`GET /api/v1/projects/{id}/leaderboard?period=week|month&category=&at=` (`leaderboard.controller.ts`, `leaderboard.service.ts`, phần tính thuần ở `leaderboard-math.ts`).
- **Kỳ:** tuần đọc `user_weekly_stats`; tháng là tháng dương lịch UTC, tính lại từ session gốc trong tháng (`monthScores`): chia theo tuần UTC, mỗi tuần dùng đúng công thức điểm tuần (`computeWeeklyScores`, phạt `user_week` chỉ trừ vào tuần của nó), rồi gộp các tuần theo trọng số số session gốc như tổng quan và hồ sơ. Tuần giáp ranh chỉ tính session thuộc tháng.
- **`from`/`to`:** `to` là mốc kết thúc không gồm (thứ Hai kế tiếp, ngày 1 tháng sau). Web hiển thị ngày cuối là `to` lùi một ngày.
- **Ai được xếp:** chỉ người còn trong `project_members` của project và chưa bị xóa (`users.deleted_at`). Người đã rời project không còn trong bảng, kể cả tuần cũ.
- **Ngưỡng:** chỉ xếp người có ít nhất 5 session gốc trong kỳ.
- **Cài đặt theo project** (`projects.settings`): `leaderboardEnabled`, `leaderboardPublic`. Leader luôn xem được. Member chỉ xem được khi cả hai cùng bật, không thì 403 `leaderboard_disabled`.
- **Member thấy gì:** hạng và điểm của mọi người, nhưng `userId`/`name` của người khác là `null`. Kèm `mySessions` và `sessionsNeeded` của chính mình.

## Báo cáo tuần theo người do AI viết (B1, M6.8)

`GET|POST /api/v1/users/{userId}/ai/weekly-report` (contract `stats.yaml`; code: `weekly-report.service.ts`, `weekly-report-prompts.ts` thuần có test, `weekly-report.controller.ts`). Dùng key BYO của **người bấm** qua `LlmService` (kind `weekly_user`, subjectType `user_week`, `subjectId` là UUID v5 của project, người và tuần: `userWeekId`).

- **Quyền** như hồ sơ thành viên: member chỉ về chính mình (403 với người khác), leader về mọi thành viên của project (404 khi người đó không thuộc project). Leader tạo báo cáo về người khác ghi audit `weekly_report.ai` (target là người được báo cáo) vì prompt của họ được gửi cho nhà cung cấp LLM.
- **Tuần** là thứ Hai UTC; bỏ trống thì lấy tuần gần nhất mà người đó có session (từ `user_weekly_stats`). Tuần không phải thứ Hai hoặc ở tương lai thì 400; tuần không có session gốc thì 409 `no_week_data`. Chưa có key thì 409 `llm_key_missing` **trước** khi đụng dữ liệu (không audit).
- **AI không nhận cả session** mà nhận: số session và token của tuần, điểm 5 nhóm của tuần này, tuần trước và trung bình team, các rule bị vi phạm trong tuần (khóa, nhóm, mức nặng nhất, số lần, lời khuyên của rule, tối đa 8), số session theo loại việc B4 (M6.7), và tối đa 3 prompt ví dụ: hai prompt đầu tiên của các session có finding nặng nhất (`needs_work`, trọng số high 3, medium 2, low 1) và một prompt đầu tiên của session có điểm trung bình cao nhất từ 70 (`good`). Mỗi prompt tối đa 400 ký tự và phải dài từ 15 ký tự; session đã mất turn do retention không còn prompt nên tự bị bỏ qua. Số session gốc đếm trực tiếp từ bảng `sessions`, không chờ bảng thống kê tuần.
- **AI chỉ viết lời nhận xét** (tóm tắt, điểm mạnh, điểm yếu, so với tuần trước, một việc nên tập, nhận xét từng ví dụ theo mã `e1`...). Server lọc mã không hợp lệ hoặc trùng và tự điền `week`, `sessionId`, `turnSeq`, `kind`, `excerpt` rồi mới lưu `ai_results`; mỗi danh sách tối đa 3 mục.
- **Chủ dữ liệu** (`subject_user_id`) là thành viên được báo cáo (kể cả khi leader bấm), nên M5.6 xóa dữ liệu một người cũng xóa các báo cáo về người đó (có test e2e).
- Kết quả chỉ người bấm đọc được; bấm lại thì ghi đè. Tool MCP `get_my_ai_results` (subjectType `user_week`) trả đúng kết quả của chính người gọi.

Test: `weekly-report-prompts.spec.ts` (đầu vào, chuẩn hóa), `test/weekly-report.e2e-spec.ts` (quyền, dữ liệu gửi đi, audit, ghi đè, tuần sai, lỗi, injection, xóa người).
