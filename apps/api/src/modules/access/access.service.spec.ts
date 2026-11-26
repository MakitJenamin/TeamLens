import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { AccessService } from './access.service.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';

function user(id: string, role: AuthUser['role'] = 'member'): AuthUser {
  return { id, email: null, name: id, role };
}

const leader = user('aaaaaaaa-0000-4000-8000-000000000002', 'leader');
const member1 = user('aaaaaaaa-0000-4000-8000-000000000003');
const member2 = user('aaaaaaaa-0000-4000-8000-000000000004');

/** Thành viên giả: member1 và member2 chỉ thuộc PROJECT. */
const MEMBERSHIPS = new Set([
  `${member1.id}:${PROJECT}`,
  `${member2.id}:${PROJECT}`,
]);

describe('AccessService', () => {
  let service: AccessService;
  let isMember: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    service = new AccessService({} as Database);
    isMember = vi
      .spyOn(service, 'isProjectMember')
      .mockImplementation(async (userId, projectId) =>
        MEMBERSHIPS.has(`${userId}:${projectId}`),
      );
  });

  describe('canAccessProject', () => {
    it('leader vào mọi project, không cần là thành viên', async () => {
      await expect(service.canAccessProject(leader, OTHER_PROJECT)).resolves.toBe(
        true,
      );
      expect(isMember).not.toHaveBeenCalled();
    });

    it('member vào project mình tham gia', async () => {
      await expect(service.canAccessProject(member1, PROJECT)).resolves.toBe(
        true,
      );
    });

    it('member không vào project khác', async () => {
      await expect(
        service.canAccessProject(member1, OTHER_PROJECT),
      ).resolves.toBe(false);
    });
  });

  describe('canViewUserData', () => {
    it('ai cũng xem được dữ liệu của chính mình', () => {
      expect(service.canViewUserData(member1, member1.id)).toBe(true);
    });

    it('leader xem được dữ liệu của mọi người', () => {
      expect(service.canViewUserData(leader, member1.id)).toBe(true);
    });

    it('member không xem được dữ liệu của member khác', () => {
      expect(service.canViewUserData(member1, member2.id)).toBe(false);
    });
  });

  describe('assertLeader', () => {
    it('leader đi qua', () => {
      expect(() => service.assertLeader(leader)).not.toThrow();
    });

    it('member bị 403', () => {
      expect(() => service.assertLeader(member1)).toThrow(
        expect.objectContaining({ status: 403 }),
      );
    });
  });
});
