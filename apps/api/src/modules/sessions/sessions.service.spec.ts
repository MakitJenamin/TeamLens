import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import type { AccessService } from '../access/access.service.js';
import type { AuditService } from '../access/audit.service.js';
import { SessionsService } from './sessions.service.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000003';
const LEADER = 'aaaaaaaa-0000-4000-8000-000000000002';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000004';

function user(id: string, leader = false): AuthUser {
  return {
    id,
    email: `${id}@x.local`,
    name: id,
    role: leader ? 'leader' : 'member',
  };
}

const sessionRow = {
  id: SESSION,
  projectId: PROJECT,
  userId: OWNER,
  userEmail: 'owner@x.local',
  userName: 'Owner',
  agent: 'claude_code',
  agentVersion: '2.1.4',
  repoRemote: 'github.com/acme/app',
  branch: 'main',
  cwdRelative: '',
  startedAt: new Date('2026-11-20T08:00:00Z'),
  startedAtExact: '2026-11-20T08:00:00.000000Z',
  endedAt: null,
  turnCount: 0,
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  parentSessionId: null,
  childCount: 1,
  permissionMode: 'weird',
  model: null,
  title: null,
  sourceId: 'claude_code:x',
  instructionFiles: null,
  deviceId: null,
  deviceName: null,
};

/** DB giả: mỗi lần `select()` trả kết quả kế tiếp trong hàng đợi; hàm builder trả lại chính nó. */
function fakeDb(results: unknown[][]): Database {
  return {
    select: () => {
      const rows = results.shift() ?? [];
      // Promise thật (await được) gắn thêm các hàm builder trả lại chính nó.
      const chain = Promise.resolve(rows) as Promise<unknown[]> &
        Record<string, unknown>;
      for (const method of [
        'from',
        'innerJoin',
        'leftJoin',
        'where',
        'orderBy',
        'limit',
      ])
        chain[method] = () => chain;
      return chain;
    },
  } as unknown as Database;
}

describe('SessionsService', () => {
  let canView: ReturnType<typeof vi.fn>;
  let isLeader: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;

  function service(results: unknown[][]) {
    canView = vi.fn();
    isLeader = vi.fn();
    record = vi.fn();
    return new SessionsService(
      fakeDb(results),
      {
        canViewUserData: canView,
        isLeader,
      } as unknown as AccessService,
      { record } as unknown as AuditService,
    );
  }

  describe('get', () => {
    it('id không phải UUID trả 404', async () => {
      await expect(service([]).get(user(OWNER), 'abc')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('không có session trả 404', async () => {
      await expect(
        service([[]]).get(user(OWNER), SESSION),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('không có quyền trả 403 và không ghi audit', async () => {
      const s = service([[sessionRow]]);
      canView.mockReturnValue(false);
      await expect(s.get(user(OTHER), SESSION)).rejects.toMatchObject({
        status: 403,
      });
      expect(record).not.toHaveBeenCalled();
    });

    it('tự xem session của mình không ghi audit', async () => {
      const s = service([[sessionRow], [], []]);
      canView.mockReturnValue(true);
      const detail = await s.get(user(OWNER), SESSION);
      expect(record).not.toHaveBeenCalled();
      expect(detail.permissionMode).toBeNull();
      expect(detail.usage).toEqual({
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
      });
    });

    it('leader xem session của người khác ghi audit session.view', async () => {
      const leader = user(LEADER, true);
      const child = {
        id: 'child',
        sourceId: 'claude_code:x:a1',
        agent: 'claude_code',
        startedAt: new Date('2026-11-20T08:01:00Z'),
        endedAt: null,
        turnCount: 2,
        title: 'việc con',
      };
      const s = service([[sessionRow], [child], []]);
      canView.mockReturnValue(true);
      const detail = await s.get(leader, SESSION);
      expect(canView).toHaveBeenCalledWith(leader, OWNER);
      expect(record).toHaveBeenCalledWith(
        leader.id,
        'session.view',
        'session',
        SESSION,
      );
      expect(detail.childSessionIds).toEqual(['child']);
      expect(detail.childCount).toBe(1);
      expect(detail.children).toEqual([
        {
          id: 'child',
          sourceId: 'claude_code:x:a1',
          agent: 'claude_code',
          title: 'việc con',
          startedAt: '2026-11-20T08:01:00.000Z',
          endedAt: null,
          turnCount: 2,
        },
      ]);
    });
  });

  describe('list', () => {
    const query = { includeSubagents: false, limit: 1 };

    it('project không tồn tại trả 404', async () => {
      await expect(
        service([[]]).list(user(OWNER, true), PROJECT, query),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('member lọc userId người khác trả 403', async () => {
      const s = service([[{ id: PROJECT }]]);
      canView.mockReturnValue(false);
      await expect(
        s.list(user(OWNER), PROJECT, { ...query, userId: OTHER }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('trả nextCursor khi còn trang sau', async () => {
      const s = service([[{ id: PROJECT }], [sessionRow, sessionRow]]);
      isLeader.mockReturnValue(true);
      const page = await s.list(user(LEADER, true), PROJECT, query);
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toEqual(expect.any(String));
    });

    it('trang cuối có nextCursor null', async () => {
      const s = service([[{ id: PROJECT }], [sessionRow]]);
      isLeader.mockReturnValue(false);
      const page = await s.list(user(OWNER), PROJECT, query);
      expect(page.nextCursor).toBeNull();
      expect(isLeader).toHaveBeenCalledWith(user(OWNER));
    });
  });
});
