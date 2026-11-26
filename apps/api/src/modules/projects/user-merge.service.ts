import { Inject, Injectable } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { ApiError, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { users } from '../../db/schema/index.js';
import { JOBS } from '../../queue/jobs.js';
import { QueueService } from '../../queue/queue.service.js';
import { isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import { toAuthUser } from '../auth/auth.service.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface MergeResult {
  user: AuthUser;
  moved: { devices: number; sessions: number; projects: number };
}

/** Chạy SQL thô trong transaction, trả các dòng. */
async function rows<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(query)) as unknown as T[];
}

/**
 * Gộp user trùng (máy thứ hai, cài lại Windows) vào user giữ lại (SPEC 11.1, task J.8).
 *
 * Mọi thứ chạy trong một transaction; job chấm lại được enqueue cùng transaction
 * (adapter `fromDrizzle` của pg-boss) nên không có job nào trỏ tới session đã bị xóa.
 */
@Injectable()
export class UserMergeService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(QueueService) private readonly queue: QueueService,
  ) {}

  async merge(
    actor: AuthUser,
    fromId: string,
    intoId: string,
  ): Promise<MergeResult> {
    if (!isUuid(fromId)) throw notFound('Không tìm thấy người dùng');
    if (fromId === intoId) {
      throw new ApiError(
        400,
        'same_user',
        'Không thể gộp một người dùng vào chính họ',
      );
    }

    return this.db.transaction(async (tx) => {
      // Khóa cả hai theo thứ tự id để hai lệnh gộp ngược chiều không deadlock.
      const locked = await tx
        .select()
        .from(users)
        .where(inArray(users.id, [fromId, intoId]))
        .orderBy(users.id)
        .for('update');
      const from = locked.find((u) => u.id === fromId && !u.deletedAt);
      const into = locked.find((u) => u.id === intoId && !u.deletedAt);
      if (!from || !into) throw notFound('Không tìm thấy người dùng');
      if (from.role === 'leader' && into.role === 'member') {
        throw new ApiError(
          409,
          'role_mismatch',
          'Không gộp leader vào member; hạ vai trò trước rồi gộp',
        );
      }

      // Session trùng source_id: giữ bản updated_at mới hơn (hòa thì giữ bản của user giữ lại),
      // xóa bản kia; turns, findings, scores, notes của bản bị xóa đi theo cascade.
      await tx.execute(sql`
        DELETE FROM sessions s
        USING sessions f, sessions i
        WHERE f.user_id = ${fromId} AND i.user_id = ${intoId}
          AND f.source_id = i.source_id
          AND s.id = CASE WHEN f.updated_at > i.updated_at THEN i.id ELSE f.id END`);

      const movedSessions = await rows<{ id: string }>(
        tx,
        sql`UPDATE sessions SET user_id = ${intoId}
            WHERE user_id = ${fromId} RETURNING id`,
      );

      // Nối lại cha/con theo parent_source_id (cha và con có thể từng nằm ở hai user khác nhau,
      // hoặc cha cũ vừa bị xóa vì trùng).
      await tx.execute(sql`
        UPDATE sessions c SET parent_session_id = p.id
        FROM sessions p
        WHERE c.user_id = ${intoId} AND p.user_id = ${intoId}
          AND c.parent_source_id IS NOT NULL
          AND p.source_id = c.parent_source_id
          AND c.parent_session_id IS DISTINCT FROM p.id`);

      const movedDevices = await rows<{ id: string }>(
        tx,
        sql`UPDATE devices SET user_id = ${intoId}
            WHERE user_id = ${fromId} RETURNING id`,
      );
      await tx.execute(
        sql`UPDATE consents SET user_id = ${intoId} WHERE user_id = ${fromId}`,
      );

      // project_members: thêm project user giữ lại chưa có; dòng trùng mất theo cascade khi xóa user.
      const movedProjects = await rows<{ project_id: string }>(
        tx,
        sql`INSERT INTO project_members (project_id, user_id)
            SELECT project_id, ${intoId}::uuid FROM project_members WHERE user_id = ${fromId}
            ON CONFLICT DO NOTHING RETURNING project_id`,
      );

      // Các cột ON DELETE SET NULL: chuyển sang user giữ lại để không mất người tạo/tác giả.
      await tx.execute(
        sql`UPDATE notes SET author_id = ${intoId} WHERE author_id = ${fromId}`,
      );
      await tx.execute(
        sql`UPDATE invites SET created_by = ${intoId} WHERE created_by = ${fromId}`,
      );
      await tx.execute(
        sql`UPDATE llm_reviews SET requested_by = ${intoId} WHERE requested_by = ${fromId}`,
      );

      // ingest_batches khóa (user_id, batch_id): batch trùng giữ bản của user giữ lại.
      await tx.execute(sql`
        UPDATE ingest_batches b SET user_id = ${intoId}
        WHERE b.user_id = ${fromId}
          AND NOT EXISTS (
            SELECT 1 FROM ingest_batches k
            WHERE k.user_id = ${intoId} AND k.batch_id = b.batch_id)`);

      // Thống kê tuần của các tuần bị ảnh hưởng không còn đúng: xóa để tính lại.
      // TODO(M3 stats): job thống kê tuần chưa có; khi có, phát job tính lại các tuần này.
      if (movedSessions.length) {
        await tx.execute(sql`
          DELETE FROM user_weekly_stats w
          USING (
            SELECT DISTINCT project_id,
              date_trunc('week', started_at AT TIME ZONE 'UTC')::date AS week
            FROM sessions WHERE id IN (${sql.join(
              movedSessions.map((s) => sql`${s.id}::uuid`),
              sql`, `,
            )})
          ) a
          WHERE w.user_id IN (${fromId}, ${intoId})
            AND w.project_id = a.project_id AND w.week = a.week`);
      }

      await this.audit.record(
        actor.id,
        'member.merge',
        'user',
        `${fromId}:${intoId}`,
        tx,
      );

      // Xóa hẳn user cũ. Phần còn lại cascade: auth_sessions, web_login_tickets, device_codes,
      // project_members/ingest_batches trùng, user_weekly_stats. audit_log.actor_id giữ lịch sử
      // nhưng FK đặt null; dòng `member.merge` ở trên ghi lại id cũ.
      await tx.execute(sql`DELETE FROM users WHERE id = ${fromId}`);

      const boss = fromDrizzle(tx, sql);
      for (const session of movedSessions) {
        await this.queue.send(
          JOBS.sessionIngested,
          { sessionId: session.id },
          { db: boss },
        );
      }

      return {
        user: toAuthUser(into),
        moved: {
          devices: movedDevices.length,
          sessions: movedSessions.length,
          projects: movedProjects.length,
        },
      };
    });
  }
}
