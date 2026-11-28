import { testDatabaseUrl } from './test-db.js';

// Chạy trong mỗi worker trước file test: trỏ app tới DB test.
process.env.DATABASE_URL = testDatabaseUrl();
// Không chạy job retention hằng đêm trên DB test: pg-boss lưu lịch trong DB và có thể chạy bù
// giữa lúc test, xóa partition `turns` mà file khác đang dùng. Test gọi `runRetention` trực tiếp.
process.env.TEAMLENS_RETENTION_JOB = 'off';
