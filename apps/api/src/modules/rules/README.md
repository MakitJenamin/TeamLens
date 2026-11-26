`evaluateSession(session, sessionRules)` chấm session gốc theo thứ tự `seq`. Truyền `parentSourceId` và các turn đã chuẩn hóa, đã che secret. Kết quả chứa khóa rule, mức độ, số đếm và bằng chứng để worker M1.11 lưu.

Ba rule M1.10 cùng các ca test nội tuyến nằm trong `session-rules.ts`. Theo RULES.md, `no-test-after-edit` tìm lệnh kiểm chứng trong toàn bộ session. Chạy `pnpm --filter @teamlens/api test` để kiểm tra.

API đăng ký worker `session.ingested` sau khi hàng đợi khởi động. Worker và lệnh dev dùng chung giao dịch chấm điểm. Chạy `pnpm --filter @teamlens/api rules:run` để tính lại trên DB đã migrate và seed; thêm `--session <UUID>` để chọn một session. Session con không có điểm. Khi retention đã xóa turn, các điểm đã tính được giữ lại.

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
