`evaluateSession(session, sessionRules)` chấm session gốc theo thứ tự `seq`. Truyền `parentSourceId` và các turn đã chuẩn hóa, đã che secret. Kết quả chứa khóa rule, mức độ, số đếm và bằng chứng để worker M1.11 lưu.

Ba rule M1.10 cùng các ca test nội tuyến nằm trong `session-rules.ts`. Theo RULES.md, `no-test-after-edit` tìm lệnh kiểm chứng trong toàn bộ session. Chạy `pnpm --filter @teamlens/api test` để kiểm tra.

API đăng ký worker `session.ingested` sau khi hàng đợi khởi động. Worker và lệnh dev dùng chung giao dịch chấm điểm. Chạy `pnpm --filter @teamlens/api rules:run` để tính lại trên DB đã migrate và seed; thêm `--session <UUID>` để chọn một session. Session con không có điểm. Khi retention đã xóa turn, các điểm đã tính được giữ lại.

`GET /api/v1/sessions/{sessionId}/findings` dùng cookie dashboard và cùng quyền xem với trang session. Đoạn trích lấy từ turn còn được lưu; khi turn hết hạn, trường `evidenceExcerpt` trả về `null`.
