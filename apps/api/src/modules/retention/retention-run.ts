import { parseArgs } from 'node:util';
import { readEnv } from '../../config/env.js';
import { createDatabase } from '../../db/client.js';
import { runRetention } from './retention.service.js';

// Chạy job retention một lần ngay (không chờ lịch hằng đêm).
//   pnpm --filter @teamlens/api retention:run              # theo settings.retention_days
//   pnpm --filter @teamlens/api retention:run --days 1     # thử với số ngày khác, không lưu cài đặt
// pnpm có thể chuyển nguyên dấu `--` vào argv, bỏ đi trước khi phân tích.
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { days: { type: 'string' } },
});
let days: number | undefined;
if (values.days !== undefined) {
  days = Number(values.days);
  if (!Number.isInteger(days) || days < 1)
    throw new Error('--days phải là số nguyên dương.');
}
const { db, sql } = createDatabase(readEnv().DATABASE_URL);
try {
  const run = await runRetention(db, { days });
  console.log(JSON.stringify(run, null, 2));
} finally {
  await sql.end();
}
