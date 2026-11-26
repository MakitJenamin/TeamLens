import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { forbidden } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { projectMembers } from '../../db/schema/index.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Phân quyền (SPEC 11.1): chỉ hai vai trò toàn server.
 * Leader làm mọi thứ và xem dữ liệu của mọi người; member chỉ dữ liệu của mình,
 * trong các project mình là thành viên.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(DB) private readonly db: Database) {}

  isLeader(user: AuthUser): boolean {
    return user.role === 'leader';
  }

  /** Ném 403 `forbidden` nếu không phải leader. */
  assertLeader(user: AuthUser): void {
    if (!this.isLeader(user)) throw forbidden();
  }

  /** `userId` có là thành viên của project không. */
  async isProjectMember(userId: string, projectId: string): Promise<boolean> {
    if (!isUuid(projectId) || !isUuid(userId)) return false;
    const [row] = await this.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, userId),
          eq(projectMembers.projectId, projectId),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Leader vào mọi project; member chỉ project mình tham gia. */
  async canAccessProject(user: AuthUser, projectId: string): Promise<boolean> {
    if (this.isLeader(user)) return true;
    return this.isProjectMember(user.id, projectId);
  }

  /**
   * `viewer` có được xem dữ liệu (session, điểm) của `ownerUserId` không.
   * Khi xem dữ liệu của người khác, nơi gọi phải ghi audit qua AuditService.
   */
  canViewUserData(viewer: AuthUser, ownerUserId: string): boolean {
    return this.isLeader(viewer) || viewer.id === ownerUserId;
  }
}
