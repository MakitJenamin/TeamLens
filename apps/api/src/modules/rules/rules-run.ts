import { parseArgs } from 'node:util';
import { asc, gt } from 'drizzle-orm';
import { readEnv } from '../../config/env.js';
import { createDatabase } from '../../db/client.js';
import { sessions } from '../../db/schema/index.js';
import { isUuid } from '../access/access.service.js';
import { installDefaultRules, scoreSession } from './score-session.js';

const { values } = parseArgs({ options: { session: { type: 'string' } } });
if (values.session !== undefined && !isUuid(values.session))
  throw new Error('--session phải là UUID.');
const { db, sql } = createDatabase(readEnv().DATABASE_URL);
try {
  await installDefaultRules(db);
  if (values.session) {
    if (!(await scoreSession(db, values.session)))
      throw new Error('Không tìm thấy session.');
    console.log('Đã chấm lại session.');
  } else {
    let cursor: string | undefined;
    let total = 0;
    while (true) {
      const batch = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(cursor ? gt(sessions.id, cursor) : undefined)
        .orderBy(asc(sessions.id))
        .limit(100);
      if (!batch.length) break;
      for (const row of batch) if (await scoreSession(db, row.id)) total++;
      cursor = batch[batch.length - 1].id;
    }
    console.log(`Đã xử lý ${total} session.`);
  }
} finally {
  await sql.end();
}
