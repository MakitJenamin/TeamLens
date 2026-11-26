import { and, eq, sql } from 'drizzle-orm';
import { readEnv } from '../../config/env.js';
import { createDatabase } from '../../db/client.js';
import {
  projects,
  projectMembers,
  sessions,
  turns,
  users,
} from '../../db/schema/index.js';
import { scoringFixtures } from './scoring-fixtures.js';

const { db, sql: client } = createDatabase(readEnv().DATABASE_URL);
try {
  const fixtures = scoringFixtures(new Date());
  await db.transaction(async (tx) => {
    const members = await tx
      .select({ id: users.id, email: users.email, projectId: projects.id })
      .from(projects)
      .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projects.slug, 'teamlens'));
    const partitions = new Set<string>();
    for (const fixture of fixtures) {
      const member = members.find((row) => row.email === fixture.email);
      if (!member)
        throw new Error(
          'Thiếu project hoặc thành viên mẫu. Hãy chạy db:seed trước.',
        );
      const month = fixture.startedAt.toISOString().slice(0, 7);
      if (!partitions.has(month)) {
        await tx.execute(
          sql`SELECT ensure_turns_partitions(${fixture.startedAt.toISOString()}::timestamptz,0)`,
        );
        partitions.add(month);
      }
      const values = {
        userId: member.id,
        projectId: member.projectId,
        sourceId: fixture.sourceId,
        agent: fixture.agent,
        startedAt: fixture.startedAt,
        endedAt: fixture.turns.at(-1)!.ts,
        repoRemote: 'github.com/makitjenamin/teamlens',
        branch: 'demo/scoring',
        cwdRelative: '',
        permissionMode: fixture.permissionMode,
        instructionFiles: fixture.instructionFiles,
        turnCount: fixture.turns.length,
        inputTokens: fixture.turns.reduce(
          (sum, t) => sum + (t.usage?.input ?? 0),
          0,
        ),
        outputTokens: fixture.turns.reduce(
          (sum, t) => sum + (t.usage?.output ?? 0),
          0,
        ),
      };
      const [row] = await tx
        .insert(sessions)
        .values(values)
        .onConflictDoUpdate({
          target: [sessions.userId, sessions.sourceId],
          set: { ...values, updatedAt: new Date() },
          setWhere: and(
            eq(sessions.projectId, member.projectId),
            eq(sessions.branch, 'demo/scoring'),
          ),
        })
        .returning({ id: sessions.id });
      if (!row)
        throw new Error('Trùng khóa với session ngoài bộ mẫu chấm điểm.');
      await tx.delete(turns).where(eq(turns.sessionId, row.id));
      await tx
        .insert(turns)
        .values(fixture.turns.map((turn) => ({ ...turn, sessionId: row.id })));
    }
  });
  console.log(
    `Đã nạp ${fixtures.length} session mẫu chấm điểm. Chạy rules:run để tính findings.`,
  );
} finally {
  await client.end();
}
