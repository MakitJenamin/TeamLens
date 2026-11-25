import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import type { ProjectRole } from '../../db/schema/index.js';
import { AccessService } from './access.service.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';

function user(id: string, isAdmin = false): AuthUser {
  return { id, email: `${id}@x.local`, name: id, isAdmin };
}

const admin = user('aaaaaaaa-0000-4000-8000-000000000001', true);
const leader = user('aaaaaaaa-0000-4000-8000-000000000002');
const member1 = user('aaaaaaaa-0000-4000-8000-000000000003');
const member2 = user('aaaaaaaa-0000-4000-8000-000000000004');
const outsider = user('aaaaaaaa-0000-4000-8000-000000000005');

/** Thành viên giả: chỉ PROJECT có thành viên. */
const MEMBERSHIPS: Record<string, ProjectRole> = {
  [`${leader.id}:${PROJECT}`]: 'leader',
  [`${member1.id}:${PROJECT}`]: 'member',
  [`${member2.id}:${PROJECT}`]: 'member',
};

describe('AccessService', () => {
  let service: AccessService;
  let getRole: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    service = new AccessService({} as Database);
    getRole = vi
      .spyOn(service, 'getRole')
      .mockImplementation(
        async (userId, projectId) =>
          MEMBERSHIPS[`${userId}:${projectId}`] ?? null,
      );
  });

  describe('assertProjectRole', () => {
    it('admin luôn được, kể cả không là thành viên', async () => {
      await expect(
        service.assertProjectRole(admin, PROJECT, ['leader']),
      ).resolves.toBeUndefined();
      expect(getRole).not.toHaveBeenCalled();
    });

    it('leader được thao tác cần leader', async () => {
      await expect(
        service.assertProjectRole(leader, PROJECT, ['leader']),
      ).resolves.toBeUndefined();
    });

    it('member bị 403 với thao tác cần leader', async () => {
      await expect(
        service.assertProjectRole(member1, PROJECT, ['leader']),
      ).rejects.toMatchObject({
        status: 403,
        response: { error: 'forbidden' },
      });
    });

    it('member được thao tác cho mọi thành viên', async () => {
      await expect(
        service.assertProjectRole(member1, PROJECT, ['leader', 'member']),
      ).resolves.toBeUndefined();
    });

    it('người ngoài và leader ở project khác bị 403', async () => {
      await expect(
        service.assertProjectRole(outsider, PROJECT, ['leader', 'member']),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.assertProjectRole(leader, OTHER_PROJECT, ['leader']),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('canViewUserData', () => {
    it('admin xem được dữ liệu của bất kỳ ai', async () => {
      expect(await service.canViewUserData(admin, member1.id, PROJECT)).toBe(
        true,
      );
      expect(
        await service.canViewUserData(admin, member1.id, OTHER_PROJECT),
      ).toBe(true);
    });

    it('leader xem được dữ liệu thành viên trong project của mình', async () => {
      expect(await service.canViewUserData(leader, member1.id, PROJECT)).toBe(
        true,
      );
    });

    it('leader không xem được ở project mình không làm leader', async () => {
      expect(
        await service.canViewUserData(leader, member1.id, OTHER_PROJECT),
      ).toBe(false);
    });

    it('member chỉ xem dữ liệu của chính mình', async () => {
      expect(await service.canViewUserData(member1, member1.id, PROJECT)).toBe(
        true,
      );
      expect(await service.canViewUserData(member1, member2.id, PROJECT)).toBe(
        false,
      );
      expect(await service.canViewUserData(member1, leader.id, PROJECT)).toBe(
        false,
      );
    });

    it('người ngoài không xem được dữ liệu người khác', async () => {
      expect(await service.canViewUserData(outsider, member1.id, PROJECT)).toBe(
        false,
      );
    });
  });
});
