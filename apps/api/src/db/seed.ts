// Script `pnpm db:seed`: dữ liệu mẫu cho dev. Chạy lại nhiều lần an toàn (idempotent).
import { and, eq, sql } from 'drizzle-orm';
import { readEnv } from '../config/env.js';
import { hashPassword } from '../common/passwords.js';
import { createDatabase, type Database } from './client.js';
import {
  projectMembers,
  projectRepos,
  projects,
  sessions,
  turns,
  type TurnKind,
  type TurnRole,
  users,
} from './schema/index.js';

const SEED_PASSWORD = 'teamlens123';

const SEED_USERS = [
  {
    key: 'admin',
    email: 'admin@teamlens.local',
    name: 'Quản trị viên',
    role: 'leader',
  },
  {
    key: 'leader',
    email: 'leader@teamlens.local',
    name: 'Trưởng nhóm',
    role: 'leader',
  },
  {
    key: 'member1',
    email: 'member1@teamlens.local',
    name: 'Thành viên 1',
    role: 'member',
  },
  {
    key: 'member2',
    email: 'member2@teamlens.local',
    name: 'Thành viên 2',
    role: 'member',
  },
] as const;
type UserKey = (typeof SEED_USERS)[number]['key'];

const SEED_PROJECTS = [
  {
    key: 'teamlens',
    name: 'TeamLens',
    slug: 'teamlens',
    repos: ['github.com/makitjenamin/teamlens'],
    members: ['leader', 'member1', 'member2'],
  },
  {
    key: 'demo',
    name: 'Demo',
    slug: 'demo',
    repos: ['github.com/acme/*'],
    members: ['leader'],
  },
] as const satisfies readonly {
  key: string;
  name: string;
  slug: string;
  repos: readonly string[];
  members: readonly UserKey[];
}[];

interface SeedTurn {
  role: TurnRole;
  kind: TurnKind;
  /** Phút kể từ lúc bắt đầu session. */
  at: number;
  model?: string;
  text?: string;
  tool?: unknown;
  output?: unknown;
  diff?: unknown;
  usage?: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
}

interface SeedSession {
  sourceId: string;
  user: UserKey;
  parent?: string;
  agent: string;
  agentVersion: string;
  branch: string;
  cwdRelative: string;
  /** Số ngày trước hôm nay. */
  daysAgo: number;
  turns: SeedTurn[];
}

const OPUS = 'claude-opus-5-5';
const usage = (input: number, output: number, cacheRead = 0) => ({
  input,
  output,
  cache_read: cacheRead,
  cache_write: 0,
});

const SEED_SESSIONS: SeedSession[] = [
  {
    sourceId: 'claude_code:seed-0001',
    user: 'member1',
    agent: 'claude_code',
    agentVersion: '2.1.4',
    branch: 'feat/health-check',
    cwdRelative: 'apps/api',
    daysAgo: 2,
    turns: [
      {
        role: 'user',
        kind: 'prompt',
        at: 0,
        text: 'Thêm endpoint GET /health trong apps/api/src/health.controller.ts trả về { status: "ok" }, không cần đăng nhập. Viết test e2e và chạy pnpm test cho tới khi qua.',
      },
      {
        role: 'assistant',
        kind: 'reply',
        at: 1,
        model: OPUS,
        text: 'Mình sẽ tạo HealthController với decorator @Public() rồi thêm test e2e.',
        usage: usage(1200, 340, 9000),
      },
      {
        role: 'assistant',
        kind: 'tool_call',
        at: 2,
        model: OPUS,
        tool: {
          name: 'Write',
          input: { file_path: 'src/health.controller.ts' },
          status: 'ok',
        },
        diff: {
          path: 'src/health.controller.ts',
          patch:
            "@@ -0,0 +1,8 @@\n+@Controller()\n+export class HealthController {\n+  @Public()\n+  @Get('health')\n+  health() {\n+    return { status: 'ok' };\n+  }\n+}",
          added: 8,
          removed: 0,
        },
        usage: usage(1500, 220, 9000),
      },
      {
        role: 'user',
        kind: 'tool_result',
        at: 2,
        tool: { name: 'Write', status: 'ok' },
        output: {
          text: 'File created successfully',
          truncated: false,
          original_bytes: 25,
        },
      },
      {
        role: 'assistant',
        kind: 'tool_call',
        at: 3,
        model: OPUS,
        tool: { name: 'Bash', input: { command: 'pnpm test' }, status: 'ok' },
        usage: usage(1800, 60, 9000),
      },
      {
        role: 'user',
        kind: 'tool_result',
        at: 4,
        tool: { name: 'Bash', status: 'ok' },
        output: {
          text: 'Test Files  3 passed (3)\nTests  12 passed (12)',
          truncated: false,
          original_bytes: 44,
        },
      },
      {
        role: 'assistant',
        kind: 'reply',
        at: 5,
        model: OPUS,
        text: 'Đã thêm /health và test e2e, toàn bộ test đều qua.',
        usage: usage(2000, 80, 9000),
      },
    ],
  },
  {
    // Session con (subagent) của session trên: prompt do agent chính viết.
    sourceId: 'claude_code:seed-0001-sub-1',
    user: 'member1',
    parent: 'claude_code:seed-0001',
    agent: 'claude_code',
    agentVersion: '2.1.4',
    branch: 'feat/health-check',
    cwdRelative: 'apps/api',
    daysAgo: 2,
    turns: [
      {
        role: 'user',
        kind: 'prompt',
        at: 1,
        text: 'Tìm các controller hiện có trong apps/api/src và liệt kê decorator xác thực đang dùng.',
      },
      {
        role: 'assistant',
        kind: 'tool_call',
        at: 1,
        model: 'claude-haiku-5-5',
        tool: { name: 'Grep', input: { pattern: '@Controller' }, status: 'ok' },
        usage: usage(800, 40),
      },
      {
        role: 'user',
        kind: 'tool_result',
        at: 1,
        tool: { name: 'Grep', status: 'ok' },
        output: {
          text: 'src/modules/auth/auth.controller.ts\nsrc/modules/projects/projects.controller.ts',
          truncated: false,
          original_bytes: 78,
        },
      },
      {
        role: 'assistant',
        kind: 'reply',
        at: 2,
        model: 'claude-haiku-5-5',
        text: 'Có 2 controller; route công khai dùng @Public().',
        usage: usage(900, 30),
      },
    ],
  },
  {
    sourceId: 'codex:seed-0002',
    user: 'member2',
    agent: 'codex',
    agentVersion: '0.9.0',
    branch: 'fix/login',
    cwdRelative: 'apps/web',
    daysAgo: 1,
    turns: [
      { role: 'user', kind: 'prompt', at: 0, text: 'fix' },
      {
        role: 'assistant',
        kind: 'reply',
        at: 1,
        model: 'gpt-5-codex',
        text: 'Bạn muốn sửa lỗi nào? Hãy mô tả lỗi hoặc chỉ ra file liên quan.',
        usage: usage(600, 40),
      },
      { role: 'user', kind: 'prompt', at: 2, text: 'trang login lỗi' },
      {
        role: 'assistant',
        kind: 'tool_call',
        at: 3,
        model: 'gpt-5-codex',
        tool: {
          name: 'shell',
          input: { command: 'pnpm --filter @teamlens/web build' },
          status: 'error',
        },
        usage: usage(900, 50),
      },
      {
        role: 'user',
        kind: 'tool_result',
        at: 4,
        tool: { name: 'shell', status: 'error' },
        output: {
          text: "Type error: Property 'email' does not exist on type '{}'.",
          truncated: false,
          original_bytes: 58,
        },
      },
      { role: 'user', kind: 'prompt', at: 6, text: 'vẫn lỗi' },
      {
        role: 'assistant',
        kind: 'reply',
        at: 7,
        model: 'gpt-5-codex',
        text: 'Mình đã thêm kiểu cho form login, build lại đã qua.',
        usage: usage(1400, 120),
      },
    ],
  },
  {
    sourceId: 'claude_code:seed-0003',
    user: 'member2',
    agent: 'claude_code',
    agentVersion: '2.1.4',
    branch: 'feat/remote-pattern',
    cwdRelative: '',
    daysAgo: 0,
    turns: [
      {
        role: 'user',
        kind: 'prompt',
        at: 0,
        text: 'Viết unit test cho normalizeRemotePattern ở apps/api/src/common/remote-pattern.ts, bao gồm dạng git@host:org/repo.git và ssh có cổng.',
      },
      {
        role: 'assistant',
        kind: 'tool_call',
        at: 1,
        model: OPUS,
        tool: {
          name: 'Bash',
          input: { command: 'pnpm --filter @teamlens/api test' },
          status: 'error',
        },
        usage: usage(2100, 90, 12000),
      },
      {
        role: 'user',
        kind: 'tool_result',
        at: 2,
        tool: { name: 'Bash', status: 'error' },
        output: {
          text: 'FAIL src/common/remote-pattern.spec.ts\nExpected: "gitlab.example.com/team/app"\nReceived: null',
          truncated: false,
          original_bytes: 92,
        },
      },
      {
        role: 'assistant',
        kind: 'reply',
        at: 4,
        model: OPUS,
        text: 'Test bắt được lỗi với URL ssh có cổng; mình đã sửa regex bỏ cổng và chạy lại test, tất cả đã qua.',
        usage: usage(2600, 150, 12000),
      },
    ],
  },
];

async function upsertUsers(db: Database): Promise<Record<UserKey, string>> {
  const passwordHash = await hashPassword(SEED_PASSWORD);
  const ids = {} as Record<UserKey, string>;
  for (const u of SEED_USERS) {
    // Không ghi đè mật khẩu/tên nếu user đã tồn tại.
    await db
      .insert(users)
      .values({
        email: u.email,
        name: u.name,
        role: u.role,
        passwordHash,
      })
      .onConflictDoNothing({ target: users.email });
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, u.email));
    ids[u.key] = row.id;
  }
  return ids;
}

async function upsertProjects(
  db: Database,
  userIds: Record<UserKey, string>,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const p of SEED_PROJECTS) {
    await db
      .insert(projects)
      .values({ name: p.name, slug: p.slug })
      .onConflictDoNothing({ target: projects.slug });
    const [row] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, p.slug));
    ids[p.key] = row.id;
    for (const pattern of p.repos) {
      await db
        .insert(projectRepos)
        .values({ projectId: row.id, remotePattern: pattern })
        .onConflictDoNothing();
    }
    for (const userKey of p.members) {
      await db
        .insert(projectMembers)
        .values({ projectId: row.id, userId: userIds[userKey] })
        .onConflictDoNothing();
    }
  }
  return ids;
}

async function upsertSessions(
  db: Database,
  userIds: Record<UserKey, string>,
  projectId: string,
): Promise<number> {
  const today = new Date();
  today.setUTCHours(8, 0, 0, 0);
  const sessionIds: Record<string, string> = {};

  for (const s of SEED_SESSIONS) {
    const startedAt = new Date(today.getTime() - s.daysAgo * 86_400_000);
    const at = (minutes: number) =>
      new Date(startedAt.getTime() + minutes * 60_000);
    const sum = (key: 'input' | 'output' | 'cache_read' | 'cache_write') =>
      s.turns.reduce((total, t) => total + (t.usage?.[key] ?? 0), 0);
    const values = {
      userId: userIds[s.user],
      projectId,
      sourceId: s.sourceId,
      agent: s.agent,
      agentVersion: s.agentVersion,
      repoRemote: 'github.com/makitjenamin/teamlens',
      branch: s.branch,
      cwdRelative: s.cwdRelative,
      startedAt,
      endedAt: at(Math.max(...s.turns.map((t) => t.at)) + 1),
      turnCount: s.turns.length,
      inputTokens: sum('input'),
      outputTokens: sum('output'),
      cacheReadTokens: sum('cache_read'),
      cacheWriteTokens: sum('cache_write'),
      parentSessionId: s.parent ? sessionIds[s.parent] : null,
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(sessions)
      .values(values)
      .onConflictDoUpdate({
        target: [sessions.userId, sessions.sourceId],
        set: values,
      })
      .returning({ id: sessions.id });
    sessionIds[s.sourceId] = row.id;

    // Thời điểm turn tính theo ngày chạy seed, nên xóa turn cũ rồi ghi lại cho chắc.
    await db.execute(
      sql`SELECT ensure_turns_partitions(${startedAt.toISOString()}::timestamptz, 0)`,
    );
    await db.delete(turns).where(eq(turns.sessionId, row.id));
    await db.insert(turns).values(
      s.turns.map((t, seq) => ({
        sessionId: row.id,
        seq,
        role: t.role,
        kind: t.kind,
        ts: at(t.at),
        model: t.model ?? null,
        text: t.text ?? null,
        tool: t.tool ?? null,
        output: t.output ?? null,
        diff: t.diff ?? null,
        usage: t.usage ? { ...t.usage, estimated: false } : null,
      })),
    );
  }
  return SEED_SESSIONS.length;
}

async function main(): Promise<void> {
  const env = readEnv();
  const { sql: client, db } = createDatabase(env.DATABASE_URL, { max: 1 });
  try {
    await db.transaction(async (tx) => {
      const userIds = await upsertUsers(tx as unknown as Database);
      const projectIds = await upsertProjects(
        tx as unknown as Database,
        userIds,
      );
      const count = await upsertSessions(
        tx as unknown as Database,
        userIds,
        projectIds.teamlens,
      );
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(turns)
        .innerJoin(sessions, eq(sessions.id, turns.sessionId))
        .where(and(eq(sessions.projectId, projectIds.teamlens)));
      console.log(
        `Seed xong: ${SEED_USERS.length} user, ${SEED_PROJECTS.length} project, ${count} session, ${n} turn (mật khẩu: ${SEED_PASSWORD}).`,
      );
    });
  } finally {
    await client.end();
  }
}

try {
  await main();
} catch (error) {
  console.error('Seed thất bại:', error);
  process.exitCode = 1;
}
