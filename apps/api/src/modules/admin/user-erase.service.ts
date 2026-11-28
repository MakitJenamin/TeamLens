import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { ApiError, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { users } from '../../db/schema/index.js';
import { isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';

/** Response `UserErasure` (contract `admin.yaml`, operationId `eraseUser`). */
export interface UserErasure {
  userId: string;
  sessions: number;
  devices: number;
}

/**
 * Xóa toàn bộ dữ liệu của một người (SPEC 6.4, 11.2, task M5.6).
 *
 * Xóa dòng `users` thì phần lớn dữ liệu đi theo FK cascade: session (kèm turn, finding, điểm,
 * ghi chú và mục thư viện prompt trên session đó), thiết bị, đồng ý, thống kê tuần, kết quả AI
 * (`user_id` lẫn `subject_user_id`), API key, token `tlp_`, thành viên project, phiên đăng nhập.
 * Ở đây chỉ xử lý phần cascade không tới: ghi chú họ viết trên session người khác (cột SET NULL)
 * và kết quả AI trỏ tới session/finding của họ nhưng thiếu `subject_user_id`.
 * Audit log giữ lại (`actor_id` thành null theo FK), kèm một dòng `user.erase`.
 *
 * Job `session.ingested` còn trong hàng đợi cho session vừa xóa không lỗi: `scoreSession`
 * không thấy session thì bỏ qua.
 */
@Injectable()
export class UserEraseService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async erase(actor: AuthUser, userId: string): Promise<UserErasure> {
    if (!isUuid(userId)) throw notFound('Không tìm thấy người dùng');

    return this.db.transaction(async (tx) => {
      // Khóa các leader còn hoạt động trước, theo thứ tự id: hai leader xóa nhau cùng lúc thì
      // lệnh sau chờ lệnh trước rồi nhận 409 thay vì deadlock.
      const leaders = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'leader'), isNull(users.deletedAt)))
        .orderBy(users.id)
        .for('update');
      // Khóa dòng user đích: ingest đồng thời (INSERT session cần khóa KEY SHARE trên user) phải chờ.
      const [target] = await tx
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .for('update');
      if (!target) throw notFound('Không tìm thấy người dùng');
      if (target.id === actor.id) {
        throw new ApiError(
          400,
          'cannot_erase_self',
          'Không thể xóa dữ liệu của chính bạn',
        );
      }
      if (target.role === 'leader' && leaders.length <= 1) {
        throw new ApiError(
          409,
          'last_leader',
          'Đây là leader cuối cùng, không thể xóa',
        );
      }

      const [counts] = (await tx.execute(sql`
        SELECT
          (SELECT count(*)::int FROM sessions WHERE user_id = ${userId}) AS sessions,
          (SELECT count(*)::int FROM devices WHERE user_id = ${userId}) AS devices
      `)) as unknown as { sessions: number; devices: number }[];

      // Ghi chú người này viết (kể cả trên session của người khác) là dữ liệu của họ.
      await tx.execute(sql`DELETE FROM notes WHERE author_id = ${userId}`);

      // Kết quả AI về session/finding của người này mà thiếu subject_user_id (subject_id không có FK).
      await tx.execute(sql`
        DELETE FROM ai_results r
        WHERE (r.subject_type = 'session' AND r.subject_id IN (
                SELECT id FROM sessions WHERE user_id = ${userId}))
           OR (r.subject_type = 'finding' AND r.subject_id IN (
                SELECT f.id FROM findings f JOIN sessions s ON s.id = f.session_id
                WHERE s.user_id = ${userId}))`);

      await tx.execute(sql`DELETE FROM users WHERE id = ${userId}`);

      // Chỉ ghi số đếm: người này đã yêu cầu xóa dữ liệu, không ghi tên hay email.
      await this.audit.record(
        actor.id,
        'user.erase',
        'user',
        userId,
        tx,
        undefined,
        { sessions: counts.sessions, devices: counts.devices },
      );

      return { userId, sessions: counts.sessions, devices: counts.devices };
    });
  }
}
