`evaluateSession(session, sessionRules)` chấm session gốc theo thứ tự `seq`. Truyền `parentSourceId` và các turn đã chuẩn hóa, đã che secret. Kết quả chứa khóa rule, mức độ, số đếm và bằng chứng để worker M1.11 lưu.

Ba rule M1.10 cùng các ca test nội tuyến nằm trong `session-rules.ts`. Theo RULES.md, `no-test-after-edit` tìm lệnh kiểm chứng trong toàn bộ session. Chạy `pnpm --filter @teamlens/api test` để kiểm tra.
