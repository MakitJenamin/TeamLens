import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp, insertUser, querySql, resetDatabase } from './helpers.js';

describe('Quản lý rule M4.4', () => {
  let app: INestApplication<App>;
  beforeAll(async () => { await resetDatabase(); app = await createTestApp(); });
  afterAll(async () => { await app?.close(); });

  it('chỉ leader chỉnh rule theo project, thử không ghi điểm, chạy lại có trạng thái', async () => {
    const server = app.getHttpServer();
    const leader = request.agent(server);
    await leader.post('/api/v1/setup').send({ email: 'leader@example.test', password: 'teamlens123', name: 'Leader' }).expect(201);
    await leader.post('/api/v1/auth/login').send({ email: 'leader@example.test', password: 'teamlens123' }).expect(200);
    const memberId = await insertUser({ email: 'member@example.test', password: 'teamlens123', name: 'Member' });
    const member = request.agent(server);
    await member.post('/api/v1/auth/login').send({ email: 'member@example.test', password: 'teamlens123' }).expect(200);
    const a: string = (await leader.post('/api/v1/projects').send({ name: 'A', slug: 'a' }).expect(201)).body.id;
    const b: string = (await leader.post('/api/v1/projects').send({ name: 'B', slug: 'b' }).expect(201)).body.id;
    await leader.post(`/api/v1/projects/${a}/members`).send({ userId: memberId }).expect(201);
    await member.get(`/api/v1/projects/${a}/rules`).expect(403);
    await member.patch(`/api/v1/projects/${a}/rules/vague-followup`).send({ enabled: false }).expect(403);
    const initial = await leader.get(`/api/v1/projects/${a}/rules`).expect(200);
    expect(initial.body).toHaveLength(24);
    const original = initial.body.find((rule: { key: string }) => rule.key === 'vague-followup');
    expect(original).toMatchObject({ source: 'default', enabled: true, severity: 'low' });

    await leader.patch(`/api/v1/projects/${a}/rules/vague-followup`).send({ thresholds: { min: -1 } }).expect(400);
    // Test nội tuyến chạy trên rule sau khi sửa (cùng đường với MCP): min 4 làm ca "ba prompt mơ hồ" không bắt nữa.
    const broken = await leader.patch(`/api/v1/projects/${a}/rules/vague-followup`).send({ thresholds: { min: 4 } }).expect(422);
    expect(broken.body.error).toBe('rule_tests_failed');
    const updated = await leader.patch(`/api/v1/projects/${a}/rules/vague-followup`)
      .send({ enabled: false, severity: 'medium', thresholds: { min: 2 } }).expect(200);
    expect(updated.body).toMatchObject({ source: 'project', enabled: false, severity: 'medium', version: original.version + 1, needsRerun: true });
    const [audit] = await querySql<{ details: Record<string, unknown> | null; metadata: unknown; target_type: string }>(
      "SELECT details, metadata, target_type FROM audit_log WHERE action='rule.save' ORDER BY at DESC LIMIT 1");
    expect(audit).toMatchObject({ target_type: 'rule', metadata: null, details: {
      via: 'dashboard', projectId: a, key: 'vague-followup',
      previous: { scope: 'default', enabled: true, severity: 'low' },
      next: { scope: 'project', enabled: false, severity: 'medium', thresholds: { min: 2 } },
    } });
    // Không đổi gì: trả rule hiện hành, không tăng phiên bản, không ghi audit.
    const same = await leader.patch(`/api/v1/projects/${a}/rules/vague-followup`).send({ enabled: false }).expect(200);
    expect(same.body.version).toBe(updated.body.version);
    // Chỉ bật/tắt: không tăng phiên bản, audit rule.set_enabled.
    const toggled = await leader.patch(`/api/v1/projects/${a}/rules/vague-followup`).send({ enabled: true }).expect(200);
    expect(toggled.body).toMatchObject({ enabled: true, version: updated.body.version });
    expect(await querySql("SELECT 1 FROM audit_log WHERE action='rule.set_enabled'")).toHaveLength(1);
    // Request đồng thời xếp hàng trên khóa dòng, kể cả khi cùng tạo bản riêng đầu tiên: không 500, không mất phiên bản.
    const parallelB = await Promise.all([1, 2, 3].map((n) =>
      leader.patch(`/api/v1/projects/${b}/rules/vague-first-prompt`).send({ thresholds: { minWords: 15 + n } })));
    expect(parallelB.map((res) => res.status)).toEqual([200, 200, 200]);
    await leader.patch(`/api/v1/projects/${a}/rules/vague-followup`).send({ enabled: false }).expect(200);
    const other = await leader.get(`/api/v1/projects/${b}/rules`).expect(200);
    expect(other.body.find((rule: { key: string }) => rule.key === 'vague-followup')).toMatchObject({ source: 'default', enabled: true, severity: 'low' });
    expect(other.body.find((rule: { key: string }) => rule.key === 'vague-first-prompt')).toMatchObject({ source: 'project', version: 4 });

    const before = await querySql<{ n: string }>('SELECT count(*)::text AS n FROM findings');
    const trial = await leader.post(`/api/v1/projects/${a}/rules/vague-followup/test`).expect(200);
    expect(trial.body).toMatchObject({ sampledSessions: 0, matchedSessions: 0, examples: [] });
    const after = await querySql<{ n: string }>('SELECT count(*)::text AS n FROM findings');
    expect(after).toEqual(before);

    await querySql(`INSERT INTO project_rescore_runs (project_id,status,updated_at) VALUES ($1,'running',now())`, [a]);
    const conflict = await leader.post(`/api/v1/projects/${a}/rules/rerun`).expect(409);
    expect(conflict.body.error).toBe('rescore_in_progress');
    // Tiến trình chết giữa chừng: quá 5 phút không cập nhật thì đọc trạng thái là thấy failed, chạy lại được.
    await querySql(`UPDATE project_rescore_runs SET updated_at=now() - interval '6 minutes' WHERE project_id=$1`, [a]);
    const stale = await leader.get(`/api/v1/projects/${a}/rules/rerun/status`).expect(200);
    expect(stale.body).toMatchObject({ status: 'failed', errorCode: 'rescore_stale' });

    // Session cũ đã bị retention xóa turn (khai 5 turn, không còn turn nào) có finding của bản ghi đè.
    const [session] = await querySql<{ id: string }>(
      `INSERT INTO sessions (user_id,project_id,source_id,agent,repo_remote,started_at,turn_count,
         input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
       VALUES ($1,$2,'old','claude_code','example.org/demo',now() - interval '200 days',5,1,1,0,0) RETURNING id`, [memberId, a]);
    const [override] = await querySql<{ id: string }>(`SELECT id FROM rules WHERE project_id=$1 AND key='vague-followup'`, [a]);
    const [finding] = await querySql<{ id: string }>(
      `INSERT INTO findings (session_id,rule_id,rule_version,turn_seq,evidence)
       VALUES ($1,$2,2,1,$3::jsonb) RETURNING id`, [session.id, override.id, JSON.stringify({ severity: 'medium', count: 3 })]);
    const accepted = await leader.post(`/api/v1/projects/${a}/rules/rerun`).expect(202);
    expect(accepted.body).toMatchObject({ status: 'queued', runId: expect.any(String) });
    const status = await leader.get(`/api/v1/projects/${a}/rules/rerun/status`).expect(200);
    expect(status.body.id).toBe(accepted.body.runId);

    // Chờ job của project trống hoàn tất rồi mới khôi phục; endpoint restore tự xếp lượt chạy lại mới.
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = await leader.get(`/api/v1/projects/${a}/rules/rerun/status`).expect(200);
      if (current.body.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // needsRerun so với lúc lần chạy bắt đầu: rule sửa trong lúc chạy vẫn cần chạy lại.
    const listAfterRun = await leader.get(`/api/v1/projects/${a}/rules`).expect(200);
    expect(listAfterRun.body.find((rule: { key: string }) => rule.key === 'vague-followup').needsRerun).toBe(false);
    await querySql(`UPDATE project_rescore_runs SET started_at=now() - interval '1 minute' WHERE id=$1`, [accepted.body.runId]);
    await querySql(`UPDATE rules SET updated_at=now() - interval '30 seconds' WHERE id=$1`, [override.id]);
    const listMidRun = await leader.get(`/api/v1/projects/${a}/rules`).expect(200);
    expect(listMidRun.body.find((rule: { key: string }) => rule.key === 'vague-followup').needsRerun).toBe(true);

    const restored = await leader.delete(`/api/v1/projects/${a}/rules/vague-followup/override`).expect(202);
    expect(restored.body.runId).toEqual(expect.any(String));
    const list = await leader.get(`/api/v1/projects/${a}/rules`).expect(200);
    expect(list.body.find((rule: { key: string }) => rule.key === 'vague-followup')).toMatchObject({ source: 'default', enabled: true });
    // Finding cũ không bị cascade xóa: chuyển sang rule mặc định, vẫn còn sau khi chấm lại.
    for (let attempt = 0; attempt < 50; attempt++) {
      const current = await leader.get(`/api/v1/projects/${a}/rules/rerun/status`).expect(200);
      if (current.body.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const [kept] = await querySql<{ project_id: string | null }>(
      'SELECT r.project_id FROM findings f JOIN rules r ON r.id=f.rule_id WHERE f.id=$1', [finding.id]);
    expect(kept).toEqual({ project_id: null });
    const [restoreAudit] = await querySql<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action='rule.restore'");
    expect(restoreAudit.details).toMatchObject({ via: 'dashboard', key: 'vague-followup', runId: restored.body.runId,
      previous: { scope: 'project' }, next: { scope: 'default' } });
  });
});
