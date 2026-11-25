import { testDatabaseUrl } from './test-db.js';

// Chạy trong mỗi worker trước file test: trỏ app tới DB test.
process.env.DATABASE_URL = testDatabaseUrl();
