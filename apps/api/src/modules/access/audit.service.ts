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

  /**
   * `details` (tùy chọn, jsonb) ghi chi tiết thay đổi, vd. giá trị cũ và mới khi sửa rule (M6.16).
   * Không đưa nội dung prompt, token hay secret vào `details`.
   */
  async record(
    actorId: string | null,
    action: AuditAction,
    targetType: AuditTargetType,
    targetId: string,
    db: Pick<Database, 'insert'> = this.db,
    details?: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await db
      .insert(auditLog)
      .values({ actorId, action, targetType, targetId, details, metadata });
  }
}
