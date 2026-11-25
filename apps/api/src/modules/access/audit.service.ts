import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { auditLog } from '../../db/schema/index.js';

/** Các hành động đang được ghi audit. Thêm mới khi cần. */
export type AuditAction =
  | 'member.add'
  | 'member.remove'
  | 'member.role_change'
  | 'repo.add'
  | 'repo.remove'
  | 'device.revoke'
  | 'user.create'
  | 'project.create'
  | 'session.view'
  | (string & {});

export type AuditTargetType =
  'project' | 'user' | 'device' | 'session' | (string & {});

/** Ghi `audit_log`. Có thể truyền transaction qua `db` để ghi cùng thao tác chính. */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async record(
    actorId: string | null,
    action: AuditAction,
    targetType: AuditTargetType,
    targetId: string,
    db: Pick<Database, 'insert'> = this.db,
  ): Promise<void> {
    await db.insert(auditLog).values({ actorId, action, targetType, targetId });
  }
}
