import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DB } from '../src/db/db.module.js';
import type { Database } from '../src/db/client.js';
import {
  readRetentionDays,
  RETENTION_LAST_RUN_KEY,
} from '../src/modules/retention/retention-settings.js';
import { runRetention } from '../src/modules/retention/retention.service.js';
import { createTestApp, insertUser, querySql, resetDatabase } from './helpers.js';

const PASSWORD = 'teamlens123';
// Dữ liệu nằm ở năm 2001 để job không đụng partition của các file test khác.
const NOW = new Date('2001-03-01T00:00:00Z');
const DAYS = 5; // mốc cắt 2001-02-24
const PARTITIONS = ['turns_y2001m01', 'turns_y2001m02', 'turns_y2001m03'];

describe('Job retention (M5.5, e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let leader: ReturnType<typeof request.agent>;
  let leaderId: string;
  let projectId: string;
  let memberId: string;
  const ids: Record<'old' | 'mid' | 'recent', string> = { old: '', mid: '', recent: '' };

  const one = async <T extends Record<string, unknown>>(text: string, params: (string | number | null)[] = []) =>
    (await querySql<T>(text, params))[0];
  const countOf = async (text: string, params: (string | number | null)[] = []) =>
    (await one<{ n: number }>(`SELECT count(*)::int AS n FROM (${text}) q`, params)).n;
  const partitionExists = async (name: string) =>
    (await one<{ r: string | null }>('SELECT to_regclass($1)::text AS r', [`public.${name}`])).r !== null;

  async function insertSession(key: keyof typeof ids, at: string, turnTimes: string[]) {
    const row = await one<{ id: string }>(
      `INSERT INTO sessions (user_id, project_id, source_id, agent, repo_remote, started_at, ended_at, turn_count)
       VALUES ($1, $2, $3, 'claude_code', 'github.com/acme/app', $4, $4, $5) RETURNING id`,
      [memberId, projectId, `claude_code:retention-${key}`, at, turnTimes.length],
    );
    ids[key] = row.id;
    for (const [seq, ts] of turnTimes.entries()) {
      await querySql(
        `INSERT INTO turns (session_id, seq, role, kind, ts, text) VALUES ($1, $2, 'user', 'prompt', $3, 'viết test cho hàm parse')`,
        [row.id, seq, ts],
      );
    }
    await querySql('INSERT INTO notes (session_id, author_id, body) VALUES ($1, $2, $3)', [row.id, leaderId, 'ghi chú']);
    await querySql(
      'INSERT INTO prompt_library (project_id, session_id, turn_seq, approved_by) VALUES ($1, $2, 0, $3)',
      [projectId, row.id, leaderId],
    );
    await querySql(
      `INSERT INTO ai_results (user_id, kind, subject_type, subject_id, subject_user_id, locale, provider, model, prompt_version, result)
       VALUES ($1, 'session_summary', 'session', $2, $3, 'vi', 'anthropic', 'm', 'test@1', '{}'::jsonb)`,
      [leaderId, row.id, memberId],
    );
    const rule = await one<{ id: string }>("SELECT id FROM rules WHERE project_id IS NULL ORDER BY key LIMIT 1");
    await querySql('INSERT INTO findings (session_id, rule_id, rule_version) VALUES ($1, $2, 1)', [row.id, rule.id]);
  }

  beforeAll(async () => {
    await resetDatabase();
    for (const name of PARTITIONS) await querySql(`DROP TABLE IF EXISTS ${name}`);
    app = await createTestApp();
    db = app.get<Database>(DB);
    leader = request.agent(app.getHttpServer());
    const setup = await leader
      .post('/api/v1/setup')
      .send({ email: 'leader@teamlens.local', name: 'Leader', password: PASSWORD })
      .expect(201);
    leaderId = setup.body.user.id;
    projectId = (await leader.post('/api/v1/projects').send({ name: 'Acme', slug: 'acme' }).expect(201)).body.id;
    memberId = await insertUser({ email: null, name: 'Thành viên' });
    await querySql("SELECT ensure_turns_partitions('2001-01-15T00:00:00Z', 1)");

    await insertSession('old', '2001-01-10T08:00:00Z', ['2001-01-10T08:00:00Z', '2001-01-10T08:05:00Z']);
    await insertSession('mid', '2001-02-20T08:00:00Z', ['2001-02-20T08:00:00Z']);
    await insertSession('recent', '2001-02-27T08:00:00Z', ['2001-02-27T08:00:00Z']);
    // Kết quả AI không gắn session (vd. cụm skill), tạo trước mốc cắt.
    await querySql(
      `INSERT INTO ai_results (user_id, kind, subject_type, subject_id, locale, provider, model, prompt_version, result, created_at)
       VALUES ($1, 'skill_triage', 'skill_cluster', gen_random_uuid(), 'vi', 'anthropic', 'm', 'test@1', '{}'::jsonb, '2001-01-05T00:00:00Z')`,
      [leaderId],
    );
  });

  afterAll(async () => {
    for (const name of PARTITIONS) await querySql(`DROP TABLE IF EXISTS ${name}`);
    await app?.close();
  });

  it('đọc số ngày: không có dòng là 90, jsonb null là vô hạn', async () => {
    expect(await readRetentionDays(db)).toBe(90);
    await querySql("INSERT INTO settings (key, value) VALUES ('retention_days', 'null'::jsonb)");
    expect(await readRetentionDays(db)).toBeNull();
    await querySql("UPDATE settings SET value = '30'::jsonb WHERE key = 'retention_days'");
    expect(await readRetentionDays(db)).toBe(30);
  });

  it('vô hạn thì không xóa gì nhưng vẫn ghi lần chạy', async () => {
    await querySql("UPDATE settings SET value = 'null'::jsonb WHERE key = 'retention_days'");
    const run = await runRetention(db, { now: NOW });
    expect(run).toMatchObject({ retentionDays: null, cutoff: null, droppedPartitions: [], deletedTurns: 0 });
    expect(await partitionExists('turns_y2001m01')).toBe(true);
    expect(await countOf("SELECT 1 FROM turns WHERE ts < '2001-03-01'")).toBe(4);
  });

  it('drop partition quá hạn cả tháng, xóa lẻ turn và nội dung thô của session hết hạn', async () => {
    const run = await runRetention(db, { now: NOW, days: DAYS });
    expect(run).toEqual({
      at: NOW.toISOString(),
      retentionDays: DAYS,
      cutoff: '2001-02-24T00:00:00.000Z',
      droppedPartitions: ['turns_y2001m01'],
      deletedTurns: 1,
      deletedAiResults: 3,
      deletedNotes: 2,
      deletedPromptLibrary: 2,
    });
    expect(await partitionExists('turns_y2001m01')).toBe(false);
    expect(await partitionExists('turns_y2001m02')).toBe(true);

    // Nội dung thô: chỉ session còn hạn giữ lại.
    expect(await countOf('SELECT 1 FROM turns WHERE session_id = $1', [ids.old])).toBe(0);
    expect(await countOf('SELECT 1 FROM turns WHERE session_id = $1', [ids.mid])).toBe(0);
    expect(await countOf('SELECT 1 FROM turns WHERE session_id = $1', [ids.recent])).toBe(1);
    for (const table of ['notes', 'prompt_library']) {
      expect(await countOf(`SELECT session_id FROM ${table}`)).toBe(1);
      expect(await countOf(`SELECT 1 FROM ${table} WHERE session_id = $1`, [ids.recent])).toBe(1);
    }
    expect(await countOf('SELECT 1 FROM ai_results')).toBe(1);
    expect(await countOf("SELECT 1 FROM ai_results WHERE subject_id = $1", [ids.recent])).toBe(1);

    // Metadata giữ lâu dài.
    expect(await countOf('SELECT 1 FROM sessions WHERE project_id = $1', [projectId])).toBe(3);
    expect(await countOf('SELECT 1 FROM findings')).toBe(3);

    // Kết quả lần chạy có trong settings, audit và GET /admin/settings.
    const stored = await one<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [RETENTION_LAST_RUN_KEY]);
    expect(stored.value).toEqual(run);
    const audit = await one<{ actor_id: string | null; metadata: Record<string, unknown> }>(
      "SELECT actor_id, metadata FROM audit_log WHERE action = 'retention.run' ORDER BY at DESC, id DESC LIMIT 1",
    );
    expect(audit.actor_id).toBeNull();
    expect(audit.metadata).toMatchObject({ droppedPartitions: ['turns_y2001m01'], deletedTurns: 1 });
    const settings = await leader.get('/api/v1/admin/settings').expect(200);
    expect(settings.body.retentionLastRun).toEqual(run);
  });

  it('chạy lại không xóa thêm', async () => {
    const run = await runRetention(db, { now: NOW, days: DAYS });
    expect(run).toMatchObject({ droppedPartitions: [], deletedTurns: 0, deletedAiResults: 0, deletedNotes: 0, deletedPromptLibrary: 0 });
  });

  it('"Thử trên 50 session" bỏ session đã bị retention xóa turn', async () => {
    const res = await leader.post(`/api/v1/projects/${projectId}/rules/no-test-after-edit/test`).expect(200);
    expect(res.body.sampledSessions).toBe(1);
  });
});
