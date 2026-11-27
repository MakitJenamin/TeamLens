import { Inject, Injectable } from '@nestjs/common';
import type {
  IngestBatch,
  IngestResult,
  IngestSessionEnvelope,
  IngestTurn,
  Schemas,
} from '@teamlens/schema';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { ApiError } from '../../common/api-error.js';
import type { AuthDevice, AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  consents,
  ingestBatches,
  projectMembers,
  projectRepos,
  sessions,
  turns,
} from '../../db/schema/index.js';
import { JOBS } from '../../queue/jobs.js';
import { ConsentTextService } from '../consent/consent-text.service.js';
import { QueueService } from '../../queue/queue.service.js';
import {
  type MemberRepoPattern,
  matchProject,
  normalizeRepoRemote,
} from './repo-match.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Rejected = Schemas['IngestRejected'];

/** Số turn mỗi câu INSERT (≈15 tham số/turn, xa giới hạn 65535 tham số của Postgres). */
const TURN_CHUNK = 500;

/** Kiểm tra ngữ nghĩa mà JSON Schema không diễn tả được. Trả về thông báo lỗi hoặc null. */
export function semanticError(envelope: IngestSessionEnvelope): string | null {
  const { session, turns: items } = envelope;
  if (
    session.ended_at &&
    Date.parse(session.ended_at) < Date.parse(session.started_at)
  ) {
    return 'ended_at trước started_at.';
  }
  const seen = new Set<number>();
  for (const t of items) {
    if (seen.has(t.seq)) return `seq ${t.seq} bị trùng trong batch.`;
    seen.add(t.seq);
  }
  if (session.parent_source_id === session.source_id) {
    return 'parent_source_id trùng với chính source_id.';
  }
  return null;
}

function turnRow(sessionId: string, t: IngestTurn) {
  return {
    sessionId,
    seq: t.seq,
    role: t.role,
    kind: t.kind,
    ts: new Date(t.ts),
    model: t.model ?? null,
    text: t.text ?? null,
    tool: t.tool ?? null,
    output: t.output ?? null,
    diff: t.diff ?? null,
    usage: t.usage ?? null,
    attachments: t.attachments ?? null,
    redactions: t.redactions ?? null,
    interrupted: t.interrupted ?? false,
    reasoningEffort: t.reasoning_effort ?? null,
  };
}

/** Đầu tháng (UTC) của một thời điểm, dạng ISO — để gọi `ensure_turns_partitions` mỗi tháng một lần. */
function monthKey(ts: string): string {
  const d = new Date(ts);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
  ).toISOString();
}

/**
 * Ghi một batch ingest (spec 7.3). Không log nội dung prompt/turn.
 *
 * Trình tự: tạo partition `turns` cần thiết (ngoài transaction) → trong một transaction:
 * giữ chỗ `batch_id` (chống trùng, kể cả hai request song song), với từng session: tìm
 * project (pattern cụ thể nhất), upsert session, ghi turn, nối cha–con, tính lại tổng,
 * phát job `session.ingested` qua adapter `fromDrizzle` của pg-boss (cùng transaction).
 */
@Injectable()
export class IngestService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly queue: QueueService,
    @Inject(ConsentTextService)
    private readonly consentText: ConsentTextService,
  ) {}

  /**
   * Thiết bị phải có bản đồng ý còn hiệu lực (chưa rút) với phiên bản văn bản hiện tại;
   * không có thì từ chối cả batch: 403 `consent_required` (SPEC 4.3).
   */
  private async assertConsent(device: AuthDevice): Promise<void> {
    const { version } = await this.consentText.get();
    const [row] = await this.db
      .select({ id: consents.id })
      .from(consents)
      .where(
        and(
          eq(consents.deviceId, device.id),
          eq(consents.textVersion, version),
          isNull(consents.revokedAt),
        ),
      )
      .limit(1);
    if (!row) {
      throw new ApiError(
        403,
        'consent_required',
        'Thiết bị này chưa đồng ý chia sẻ dữ liệu. Chạy `tl consent` để xem và đồng ý.',
      );
    }
  }

  async ingest(
    user: AuthUser,
    device: AuthDevice,
    batch: IngestBatch,
  ): Promise<IngestResult> {
    await this.assertConsent(device);
    const months = new Set(
      batch.sessions.flatMap((s) => s.turns.map((t) => monthKey(t.ts))),
    );
    for (const month of months) {
      await this.db.execute(
        sql`SELECT ensure_turns_partitions(${month}::timestamptz, 0)`,
      );
    }

    return this.db.transaction(async (tx) => {
      const reserved = await tx
        .insert(ingestBatches)
        .values({
          userId: user.id,
          batchId: batch.batch_id,
          deviceId: device.id,
          result: {},
        })
        .onConflictDoNothing()
        .returning({ batchId: ingestBatches.batchId });
      if (reserved.length === 0) {
        const [existing] = await tx
          .select({ result: ingestBatches.result })
          .from(ingestBatches)
          .where(
            and(
              eq(ingestBatches.userId, user.id),
              eq(ingestBatches.batchId, batch.batch_id),
            ),
          );
        return { ...(existing.result as IngestResult), duplicate: true };
      }

      const patterns = await this.memberPatterns(tx, user.id);
      const result: IngestResult = {
        batchId: batch.batch_id,
        duplicate: false,
        accepted: [],
        rejected: [],
      };
      const boss = fromDrizzle(tx, sql);

      for (const envelope of batch.sessions) {
        const rejected = this.check(envelope, patterns);
        if ('error' in rejected) {
          result.rejected.push(rejected);
          continue;
        }
        const sessionId = await this.writeSession(
          tx,
          user.id,
          device.id,
          rejected.projectId,
          envelope,
        );
        await this.queue.send(
          JOBS.sessionIngested,
          { sessionId },
          { db: boss },
        );
        result.accepted.push({
          sourceId: envelope.session.source_id,
          sessionId,
          turnsUpserted: envelope.turns.length,
        });
      }

      await tx
        .update(ingestBatches)
        .set({ result })
        .where(
          and(
            eq(ingestBatches.userId, user.id),
            eq(ingestBatches.batchId, batch.batch_id),
          ),
        );
      return result;
    });
  }

  /** Repo pattern của mọi project user là thành viên, theo thứ tự thêm repo (ổn định). */
  private memberPatterns(tx: Tx, userId: string): Promise<MemberRepoPattern[]> {
    return tx
      .select({
        projectId: projectRepos.projectId,
        remotePattern: projectRepos.remotePattern,
      })
      .from(projectRepos)
      .innerJoin(
        projectMembers,
        eq(projectMembers.projectId, projectRepos.projectId),
      )
      .where(eq(projectMembers.userId, userId))
      .orderBy(asc(projectRepos.createdAt), asc(projectRepos.id));
  }

  private check(
    envelope: IngestSessionEnvelope,
    patterns: readonly MemberRepoPattern[],
  ): Rejected | { projectId: string } {
    const sourceId = envelope.session.source_id;
    const invalid = semanticError(envelope);
    if (invalid) {
      return {
        sourceId,
        error: 'invalid_session',
        message: `Session không hợp lệ: ${invalid}`,
      };
    }
    const remote = normalizeRepoRemote(envelope.session.repo_remote);
    const projectId = matchProject(remote, patterns);
    if (!projectId) {
      return {
        sourceId,
        error: 'repo_not_in_project',
        message: `Repo ${remote} không thuộc project nào bạn là thành viên.`,
      };
    }
    return { projectId };
  }

  private async writeSession(
    tx: Tx,
    userId: string,
    deviceId: string,
    projectId: string,
    envelope: IngestSessionEnvelope,
  ): Promise<string> {
    const s = envelope.session;
    const [parent] = s.parent_source_id
      ? await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.userId, userId),
              eq(sessions.sourceId, s.parent_source_id),
            ),
          )
      : [];

    const values = {
      userId,
      projectId,
      deviceId,
      sourceId: s.source_id,
      agent: s.agent,
      agentVersion: s.agent_version,
      repoRemote: normalizeRepoRemote(s.repo_remote),
      branch: s.branch,
      cwdRelative: s.cwd_relative,
      startedAt: new Date(s.started_at),
      endedAt: s.ended_at ? new Date(s.ended_at) : null,
      parentSourceId: s.parent_source_id,
      parentSessionId: parent?.id ?? null,
      permissionMode: s.permission_mode ?? null,
      instructionFiles: s.instruction_files ?? null,
    };
    const [row] = await tx
      .insert(sessions)
      .values(values)
      .onConflictDoUpdate({
        target: [sessions.userId, sessions.sourceId],
        set: {
          ...values,
          // CLI không gửi hai trường này (bản cũ hoặc không thu thập) thì giữ giá trị đã có.
          permissionMode: sql`coalesce(excluded.permission_mode, ${sessions.permissionMode})`,
          instructionFiles: sql`coalesce(excluded.instruction_files, ${sessions.instructionFiles})`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: sessions.id });
    const sessionId = row.id;

    // Session con tới trước cha: nối lại khi cha tới.
    await tx
      .update(sessions)
      .set({ parentSessionId: sessionId })
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.parentSourceId, s.source_id),
          sql`${sessions.parentSessionId} IS DISTINCT FROM ${sessionId}`,
        ),
      );

    // Upsert turn theo (session_id, seq): PK thật là (session_id, seq, ts) vì partition,
    // nên xóa seq cũ (kể cả khi ts đổi) rồi ghi lại.
    if (envelope.turns.length > 0) {
      await tx.delete(turns).where(
        and(
          eq(turns.sessionId, sessionId),
          inArray(
            turns.seq,
            envelope.turns.map((t) => t.seq),
          ),
        ),
      );
      for (let i = 0; i < envelope.turns.length; i += TURN_CHUNK) {
        await tx
          .insert(turns)
          .values(
            envelope.turns
              .slice(i, i + TURN_CHUNK)
              .map((t) => turnRow(sessionId, t)),
          );
      }
    }

    // Tính lại số turn và tổng token từ toàn bộ turn đã có (gửi tăng dần vẫn đúng).
    await tx.execute(sql`
      UPDATE sessions s SET
        turn_count = agg.n,
        input_tokens = agg.input,
        output_tokens = agg.output,
        cache_read_tokens = agg.cache_read,
        cache_write_tokens = agg.cache_write
      FROM (
        SELECT
          count(*)::int AS n,
          coalesce(sum((usage->>'input')::bigint), 0) AS input,
          coalesce(sum((usage->>'output')::bigint), 0) AS output,
          coalesce(sum((usage->>'cache_read')::bigint), 0) AS cache_read,
          coalesce(sum((usage->>'cache_write')::bigint), 0) AS cache_write
        FROM turns WHERE session_id = ${sessionId}
      ) agg
      WHERE s.id = ${sessionId}
    `);
    return sessionId;
  }
}
