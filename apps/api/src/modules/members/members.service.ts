import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, max } from 'drizzle-orm';
import { notFound } from '../../common/api-error.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  devices,
  projectMembers,
  projects,
  sessions,
  users,
} from '../../db/schema/index.js';
import { buildMemberStatus, type MemberStatusDto } from './member-status.js';

/**
 * Trang Thành viên (M4.2, contract `members.yaml`). Ba truy vấn cố định, không phụ thuộc số thành viên:
 * thành viên kèm session gần nhất, rồi mọi thiết bị của họ. Chỉ là metadata nên không ghi audit
 * (giống `listProjectMembers`).
 */
@Injectable()
export class MembersService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async listStatus(
    projectId: string,
    now = new Date(),
  ): Promise<{ items: MemberStatusDto[] }> {
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw notFound('Không tìm thấy project');

    const lastSession = this.db
      .select({
        userId: sessions.userId,
        lastSessionAt: max(sessions.startedAt).as('last_session_at'),
      })
      .from(sessions)
      .where(eq(sessions.projectId, projectId))
      .groupBy(sessions.userId)
      .as('last_session');

    const members = await this.db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        joinedAt: projectMembers.createdAt,
        lastSessionAt: lastSession.lastSessionAt,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .leftJoin(lastSession, eq(lastSession.userId, users.id))
      .where(
        and(eq(projectMembers.projectId, projectId), isNull(users.deletedAt)),
      );
    if (members.length === 0) return { items: [] };

    const deviceRows = await this.db
      .select({
        id: devices.id,
        userId: devices.userId,
        name: devices.name,
        os: devices.os,
        cliVersion: devices.cliVersion,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
        createdAt: devices.createdAt,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .where(
        inArray(
          devices.userId,
          members.map((m) => m.userId),
        ),
      );

    return { items: buildMemberStatus(members, deviceRows, now) };
  }
}
