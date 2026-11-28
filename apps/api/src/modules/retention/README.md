Job retention hằng đêm (M5.5, SPEC 11.2). Code: `retention.service.ts` (`runRetention`), `retention-settings.ts` (đọc cài đặt, kiểu `RetentionRun`), `retention.worker.ts` (lịch và worker), `retention-run.ts` (chạy tay).

## Làm gì

1. Tạo trước partition `turns` cho tháng này và 2 tháng tới (`ensure_turns_partitions`).
2. Đọc `settings.retention_days` bằng `readRetentionDays`: không có dòng thì 90 ngày, jsonb `null` là **vô hạn** (không xóa gì). Module khác cần số ngày thì dùng hàm này, đừng tự viết `value ?? 90`.
3. Mốc cắt = bây giờ − số ngày. Drop partition `turns` có cận trên ≤ mốc cắt (cả tháng quá hạn); mỗi lần drop là một lệnh riêng để khóa bảng cha thật ngắn.
4. Trong một transaction:
   - Xóa lẻ turn có `ts` trước mốc cắt (partition chỉ quá hạn một phần).
   - Với session hết hạn (`coalesce(ended_at, started_at)` trước mốc cắt), xóa ghi chú, mục `prompt_library` và kết quả AI gắn với session hoặc finding của nó.
   - Xóa kết quả AI tạo trước mốc cắt.
5. Ghi kết quả vào `settings.retention_last_run` (trang Quản trị hiện "Dọn lần cuối", `GET /api/v1/admin/settings` trả `retentionLastRun`) và audit `retention.run` (không có người thực hiện, chỉ số đếm).

**Giữ lại:** metadata session, finding, điểm (`session_scores`), `user_weekly_stats`, audit log. Rule engine nhận ra session đã mất turn (`turns.length < turn_count`): "Chạy lại" (`scoreSession`) và "Thử trên 50 session" (`RuleConfigService.test`) đều bỏ qua các session này.

## Lịch

pg-boss `schedule('retention.nightly', '15 2 * * *', tz UTC, missed: 'once')`, tức 09:15 giờ Việt Nam. Lịch lưu trong DB nên nhiều instance API vẫn chỉ ra một job; server tắt đúng giờ thì chạy bù một lần khi bật lại. Chạy lại nhiều lần an toàn.

`TEAMLENS_RETENTION_JOB=off` gỡ lịch và không nhận job. E2e luôn đặt biến này (`test/setup-env.ts`), vì nếu job chạy bù giữa lúc test thì partition mà file khác đang dùng sẽ bị xóa. Dev muốn giữ dữ liệu mẫu cũ thì đặt biến này trong `apps/api/.env`.

## Chạy tay

```bash
pnpm --filter @teamlens/api retention:run             # theo cài đặt hiện tại
pnpm --filter @teamlens/api retention:run --days 1    # thử với số ngày khác (không lưu cài đặt)
```

In ra `RetentionRun` dạng JSON. Lệnh **xóa thật** trên DB của `DATABASE_URL`.

## Hạn chế

- Session cũ được gửi lại sau này (backfill) thì turn của nó lại vào DB và bị xóa ở lần chạy kế tiếp.
- Kết quả AI về cụm skill hay project không gắn với session nên chỉ xóa theo `created_at`.
