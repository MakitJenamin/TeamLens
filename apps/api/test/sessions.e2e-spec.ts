import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp, querySql, resetDatabase } from './helpers.js';

const PASSWORD = 'teamlens123';
const MISSING = '99999999-9999-4999-8999-999999999999';

// Xem session trên dashboard (M1.8): quyền, audit, phân trang.
describe('Sessions (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let projectId: string;
  let otherProjectId: string;
  const ids: Record<'leader' | 'member1' | 'member2', string> = {
    leader: '',
    member1: '',
    member2: '',
  };
  /** Session gốc của member1 (5 cái), mới nhất trước. */
  let member1Sessions: string[] = [];
  let member2Session: string;
  let childSession: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    server = app.getHttpServer();

    await request(server)
      .post('/api/v1/setup')
      .send({
        email: 'admin@teamlens.local',
        name: 'Admin',
        password: PASSWORD,
      })
      .expect(201);
    const admin = await loginAs('admin@teamlens.local');
    for (const key of ['leader', 'member1', 'member2'] as const) {
      const res = await admin
        .post('/api/v1/users')
        .send({ email: `${key}@teamlens.local`, name: key, password: PASSWORD })
        .expect(201);
      ids[key] = res.body.id;
    }
    projectId = (
      await admin
        .post('/api/v1/projects')
        .send({ name: 'P', slug: 'p' })
        .expect(201)
    ).body.id;
    otherProjectId = (
      await admin
        .post('/api/v1/projects')
        .send({ name: 'Q', slug: 'q' })
        .expect(201)
    ).body.id;
    for (const [key, role] of [
      ['leader', 'leader'],
      ['member1', 'member'],
      ['member2', 'member'],
    ] as const) {
      await admin
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ email: `${key}@teamlens.local`, role })
        .expect(201);
    }

    const base = Date.parse('2026-11-20T08:00:00.000Z');
    // Hai session cùng started_at để kiểm tra cursor ổn định theo id.
    const starts = [0, -1, -1, -2, -3].map((h) =>
      new Date(base + h * 3_600_000).toISOString(),
    );
    await querySql(`SELECT ensure_turns_partitions($1::timestamptz, 0)`, [
      starts[4],
    ]);
    const created: { id: string; started: string }[] = [];
    for (const [i, started] of starts.entries()) {
      created.push({
        id: await insertSession(ids.member1, `claude_code:m1-${i}`, started),
        started,
      });
    }
    member1Sessions = created
      .sort((a, b) =>
        a.started === b.started
          ? b.id.localeCompare(a.id)
          : b.started.localeCompare(a.started),
      )
      .map((s) => s.id);
    member2Session = await insertSession(
      ids.member2,
      'codex:m2-0',
      new Date(base - 3_600_000 * 5).toISOString(),
      { agent: 'codex' },
    );
    childSession = await insertSession(
      ids.member1,
      'claude_code:m1-0-sub',
      new Date(base + 60_000).toISOString(),
      { parent: created[0].id },
    );
    // Turn chèn lộn thứ tự để kiểm tra sắp theo seq.
    for (const seq of [2, 0, 1]) {
      await querySql(
        `INSERT INTO turns (session_id, seq, role, kind, ts, model, text, tool, output)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8::jsonb, $9::jsonb)`,
        [
          created[0].id,
          seq,
          seq === 0 ? 'user' : 'assistant',
          seq === 0 ? 'prompt' : seq === 1 ? 'reply' : 'tool_call',
          new Date(base + seq * 1000).toISOString(),
          seq === 0 ? null : 'claude-opus-5-5',
          seq === 2 ? null : `turn ${seq}`,
          seq === 2
            ? JSON.stringify({ name: 'Bash', input: { command: 'ls' } })
            : null,
          seq === 2
            ? JSON.stringify({ text: 'a', truncated: true, original_bytes: 9 })
            : null,
        ],
      );
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  async function insertSession(
    userId: string,
    sourceId: string,
    startedAt: string,
    opts: { agent?: string; parent?: string } = {},
  ): Promise<string> {
    const [row] = await querySql<{ id: string }>(
      `INSERT INTO sessions (user_id, project_id, source_id, agent, repo_remote, started_at,
         turn_count, input_tokens, parent_session_id, permission_mode, instruction_files)
       VALUES ($1, $2, $3, $4, 'github.com/acme/app', $5::timestamptz, 3, 100, $6, 'plan',
         '[{"path":"CLAUDE.md","bytes":120}]'::jsonb)
       RETURNING id`,
      [
        userId,
        projectId,
        sourceId,
        opts.agent ?? 'claude_code',
        startedAt,
        opts.parent ?? null,
      ],
    );
    return row.id;
  }

  async function loginAs(email: string) {
    const agent = request.agent(server);
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return agent;
  }

  async function auditCount(sessionId: string): Promise<number> {
    const [row] = await querySql<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'session.view' AND target_id = $1`,
      [sessionId],
    );
    return Number(row.n);
  }

  describe('GET /api/v1/projects/:projectId/sessions', () => {
    it('cần đăng nhập', async () => {
      await request(server)
        .get(`/api/v1/projects/${projectId}/sessions`)
        .expect(401);
    });

    it('member chỉ thấy session của mình, ẩn session con', async () => {
      const member1 = await loginAs('member1@teamlens.local');
      const res = await member1
        .get(`/api/v1/projects/${projectId}/sessions`)
        .expect(200);
      expect(res.body.items.map((s: { id: string }) => s.id)).toEqual(
        member1Sessions,
      );
      expect(res.body.nextCursor).toBeNull();
      expect(res.body.items[0]).toMatchObject({
        projectId,
        user: { id: ids.member1, email: 'member1@teamlens.local' },
        agent: 'claude_code',
        model: 'claude-opus-5-5',
        title: 'turn 0',
        turnCount: 3,
        usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
        parentSessionId: null,
        permissionMode: 'plan',
      });
    });

    it('member lọc userId người khác bị 403, lọc chính mình thì được', async () => {
      const member1 = await loginAs('member1@teamlens.local');
      await member1
        .get(`/api/v1/projects/${projectId}/sessions?userId=${ids.member2}`)
        .expect(403);
      await member1
        .get(`/api/v1/projects/${projectId}/sessions?userId=${ids.member1}`)
        .expect(200);
    });

    it('leader thấy mọi session trong project, lọc được theo agent và user', async () => {
      const leader = await loginAs('leader@teamlens.local');
      const all = await leader
        .get(`/api/v1/projects/${projectId}/sessions`)
        .expect(200);
      expect(all.body.items).toHaveLength(6);
      const codex = await leader
        .get(`/api/v1/projects/${projectId}/sessions?agent=codex`)
        .expect(200);
      expect(codex.body.items.map((s: { id: string }) => s.id)).toEqual([
        member2Session,
      ]);
      const byUser = await leader
        .get(`/api/v1/projects/${projectId}/sessions?userId=${ids.member2}`)
        .expect(200);
      expect(byUser.body.items).toHaveLength(1);
      const withSub = await leader
        .get(`/api/v1/projects/${projectId}/sessions?includeSubagents=true`)
        .expect(200);
      expect(withSub.body.items).toHaveLength(7);
      expect(withSub.body.items[0]).toMatchObject({
        id: childSession,
        parentSessionId: member1Sessions[0],
      });
    });

    it('lọc from/to theo startedAt', async () => {
      const leader = await loginAs('leader@teamlens.local');
      const res = await leader
        .get(
          `/api/v1/projects/${projectId}/sessions?from=2026-11-20T06:30:00Z&to=2026-11-20T08:00:00Z`,
        )
        .expect(200);
      expect(res.body.items).toHaveLength(2);
    });

    it('người không thuộc project bị 403, admin thấy tất cả', async () => {
      const admin = await loginAs('admin@teamlens.local');
      const res = await admin
        .get(`/api/v1/projects/${projectId}/sessions`)
        .expect(200);
      expect(res.body.items).toHaveLength(6);
      const leader = await loginAs('leader@teamlens.local');
      await leader
        .get(`/api/v1/projects/${otherProjectId}/sessions`)
        .expect(403);
    });

    it('project không tồn tại trả 404', async () => {
      const admin = await loginAs('admin@teamlens.local');
      await admin.get(`/api/v1/projects/${MISSING}/sessions`).expect(404);
      await admin.get(`/api/v1/projects/abc/sessions`).expect(404);
    });

    it('phân trang cursor ổn định, không trùng không sót', async () => {
      const member1 = await loginAs('member1@teamlens.local');
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string =
          `/api/v1/projects/${projectId}/sessions?limit=2` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const res = await member1.get(url).expect(200);
        seen.push(...res.body.items.map((s: { id: string }) => s.id));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual(member1Sessions);
    });

    it('tham số sai trả 400 validation_error', async () => {
      const leader = await loginAs('leader@teamlens.local');
      for (const qs of [
        'limit=0',
        'limit=101',
        'agent=cursor',
        'cursor=rac',
        'from=hom-qua',
        'includeSubagents=yes',
      ]) {
        const res = await leader
          .get(`/api/v1/projects/${projectId}/sessions?${qs}`)
          .expect(400);
        expect(res.body.error).toBe('validation_error');
      }
    });
  });

  describe('GET /api/v1/sessions/:sessionId', () => {
    it('chủ session xem được, turn theo seq, không ghi audit', async () => {
      const member1 = await loginAs('member1@teamlens.local');
      const res = await member1
        .get(`/api/v1/sessions/${member1Sessions[0]}`)
        .expect(200);
      expect(res.body).toMatchObject({
        id: member1Sessions[0],
        sourceId: 'claude_code:m1-0',
        device: null,
        instructionFiles: [{ path: 'CLAUDE.md', bytes: 120 }],
        childSessionIds: [childSession],
        permissionMode: 'plan',
      });
      expect(res.body.turns.map((t: { seq: number }) => t.seq)).toEqual([
        0, 1, 2,
      ]);
      expect(res.body.turns[2]).toMatchObject({
        kind: 'tool_call',
        tool: { name: 'Bash', input: { command: 'ls' }, status: null },
        output: { text: 'a', truncated: true, originalBytes: 9 },
        diff: null,
        usage: null,
        attachments: [],
        redactions: [],
        interrupted: false,
      });
      expect(await auditCount(member1Sessions[0])).toBe(0);
    });

    it('member xem session người khác bị 403', async () => {
      const member1 = await loginAs('member1@teamlens.local');
      const res = await member1
        .get(`/api/v1/sessions/${member2Session}`)
        .expect(403);
      expect(res.body.error).toBe('forbidden');
      expect(await auditCount(member2Session)).toBe(0);
    });

    it('leader xem session của member thì ghi audit session.view', async () => {
      const leader = await loginAs('leader@teamlens.local');
      await leader.get(`/api/v1/sessions/${member2Session}`).expect(200);
      const rows = await querySql<{ actor_id: string; target_type: string }>(
        `SELECT actor_id, target_type FROM audit_log WHERE action = 'session.view' AND target_id = $1`,
        [member2Session],
      );
      expect(rows).toEqual([{ actor_id: ids.leader, target_type: 'session' }]);
    });

    it('leader bị hạ xuống member thì không xem được nữa', async () => {
      // Đổi thẳng trong DB: API chặn hạ leader cuối cùng của project.
      const setRole = (role: string) =>
        querySql(
          `UPDATE project_members SET role = $1 WHERE project_id = $2 AND user_id = $3`,
          [role, projectId, ids.leader],
        );
      await setRole('member');
      try {
        const leader = await loginAs('leader@teamlens.local');
        await leader.get(`/api/v1/sessions/${member2Session}`).expect(403);
      } finally {
        await setRole('leader');
      }
    });

    it('admin xem được và có ghi audit', async () => {
      const admin = await loginAs('admin@teamlens.local');
      const before = await auditCount(member1Sessions[1]);
      await admin.get(`/api/v1/sessions/${member1Sessions[1]}`).expect(200);
      expect(await auditCount(member1Sessions[1])).toBe(before + 1);
    });

    it('session không tồn tại hoặc id sai trả 404', async () => {
      const admin = await loginAs('admin@teamlens.local');
      const res = await admin.get(`/api/v1/sessions/${MISSING}`).expect(404);
      expect(res.body.error).toBe('not_found');
      await admin.get(`/api/v1/sessions/khong-phai-uuid`).expect(404);
    });
  });
});
