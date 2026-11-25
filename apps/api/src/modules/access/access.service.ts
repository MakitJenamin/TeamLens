import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { forbidden } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { type ProjectRole, projectMembers } from '../../db/schema/index.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Phân quyền theo project (mục 11.1 của spec).
 * Admin luôn được; leader được trong project của mình; member chỉ dữ liệu của chính mình.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Vai trò của user trong project, `null` nếu không phải thành viên. */
  async getRole(
    userId: string,
    projectId: string,
  ): Promise<ProjectRole | null> {
    if (!isUuid(projectId) || !isUuid(userId)) return null;
    const [row] = await this.db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, userId),
          eq(projectMembers.projectId, projectId),
        ),
      )
      .limit(1);
    return row?.role ?? null;
  }

  /** User có một trong các vai trò `roles` trong project (admin luôn qua)? */
  async hasProjectRole(
    user: AuthUser,
    projectId: string,
    roles: readonly ProjectRole[],
  ): Promise<boolean> {
    if (user.isAdmin) return true;
    const role = await this.getRole(user.id, projectId);
    return role !== null && roles.includes(role);
  }

  /** Như `hasProjectRole` nhưng ném 403 `forbidden` nếu không đủ quyền. */
  async assertProjectRole(
    user: AuthUser,
    projectId: string,
    roles: readonly ProjectRole[],
  ): Promise<void> {
    if (!(await this.hasProjectRole(user, projectId, roles))) throw forbidden();
  }

  /**
   * `viewer` có được xem dữ liệu (session, điểm) của `ownerUserId` trong project không.
   * Khi xem dữ liệu của người khác, nơi gọi phải ghi audit qua AuditService.
   */
  async canViewUserData(
    viewer: AuthUser,
    ownerUserId: string,
    projectId: string,
  ): Promise<boolean> {
    if (viewer.isAdmin) return true;
    if (viewer.id === ownerUserId) return true;
    return (await this.getRole(viewer.id, projectId)) === 'leader';
  }
}
