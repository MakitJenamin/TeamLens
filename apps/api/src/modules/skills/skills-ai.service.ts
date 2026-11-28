import { Inject, Injectable } from '@nestjs/common';
import type { AiResult, SkillClusterAiResults } from '@teamlens/schema';
import { eq } from 'drizzle-orm';
import { ApiError, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { aiResults } from '../../db/schema/index.js';
import { AccessService, isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import { llmError } from '../llm/llm-errors.js';
import { LlmService, toAiResult } from '../llm/llm.service.js';
import type { AiLocale, AiResultRow } from '../llm/llm.types.js';
import {
  clusterPrompts,
  MAX_CLUSTERS,
  occurrencesOf,
} from './prompt-clusterer.js';
import {
  clusterBlocks,
  CONTENT_SYSTEM,
  contentSchema,
  EXAMPLES_FOR_AI,
  normalizeContent,
  normalizeTriage,
  PROMPT_VERSIONS,
  TRIAGE_SYSTEM,
  triageSchema,
} from './skills-ai-prompts.js';
import {
  clusterIdOf,
  type ListSkillClustersQuery,
  SkillsService,
} from './skills.service.js';

const clusterNotFound = () =>
  new ApiError(
    404,
    'cluster_not_found',
    'Không tìm thấy cụm trong khoảng thời gian này, hãy thử mở rộng khoảng.',
  );

export type RunSkillAiInput = Pick<
  ListSkillClustersQuery,
  'userId' | 'from' | 'to'
>;

/**
 * Nút AI của Skill Finder (M6.12): S1 triage cụm, S2 sinh `SKILL.md`. Dùng key BYO của chính người bấm (`LlmService`).
 *
 * Server dựng lại cụm từ prompt người bấm xem được (cùng `SkillsService.collect` với danh sách cụm) rồi gửi tối đa
 * {@link EXAMPLES_FOR_AI} prompt của cụm cho LLM. Leader chạy AI trên prompt của người khác ghi audit `skill_clusters.ai`.
 * Kết quả chỉ người bấm đọc được. Server không ghi file nào: `SKILL.md` chỉ được trả về.
 *
 * Kết quả được **chuẩn hóa rồi mới lưu** (tên kebab-case, S2 có thêm `markdown` đã ghép), để cả web lẫn tool MCP
 * `get_my_ai_results` (đọc thẳng `ai_results`) thấy cùng một nội dung.
 */
@Injectable()
export class SkillsAiService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LlmService) private readonly llm: LlmService,
  ) {}

  /** Kết quả AI đã lưu của chính người gọi cho cụm. Không dựng lại cụm nên không ghi audit. */
  async results(
    viewer: AuthUser,
    projectId: string,
    clusterId: string,
    locale: AiLocale,
  ): Promise<SkillClusterAiResults> {
    await this.skills.assertProjectAccess(viewer, projectId);
    if (!isUuid(clusterId)) throw notFound('Không tìm thấy cụm');
    const rows = await this.llm.findResults(viewer.id, {
      subjectType: 'skill_cluster',
      subjectIds: [clusterId],
      locale,
    });
    const pick = (kind: string) => {
      const row = rows.find((r) => r.kind === kind);
      return row ? this.toResult(row) : null;
    };
    return { triage: pick('skill_triage'), skill: pick('skill_content') };
  }

  /** S1: cụm này có đáng làm thành skill không. */
  async triage(
    viewer: AuthUser,
    projectId: string,
    clusterId: string,
    input: RunSkillAiInput,
    locale: AiLocale,
  ): Promise<AiResult> {
    const target = await this.prepare(viewer, projectId, clusterId, input);
    const row = await this.llm.run(viewer.id, {
      kind: 'skill_triage',
      subjectType: 'skill_cluster',
      subjectId: clusterId,
      subjectUserId: target.subjectUserId,
      locale,
      promptVersion: PROMPT_VERSIONS.triage,
      system: TRIAGE_SYSTEM,
      untrusted: target.blocks,
      schema: triageSchema,
      maxOutputTokens: 800,
    });
    return this.finish(row);
  }

  /** S2: soạn `SKILL.md` từ cụm. */
  async skill(
    viewer: AuthUser,
    projectId: string,
    clusterId: string,
    input: RunSkillAiInput,
    locale: AiLocale,
  ): Promise<AiResult> {
    const target = await this.prepare(viewer, projectId, clusterId, input);
    const row = await this.llm.run(viewer.id, {
      kind: 'skill_content',
      subjectType: 'skill_cluster',
      subjectId: clusterId,
      subjectUserId: target.subjectUserId,
      locale,
      promptVersion: PROMPT_VERSIONS.content,
      system: CONTENT_SYSTEM,
      untrusted: target.blocks,
      schema: contentSchema,
      maxOutputTokens: 3000,
    });
    return this.finish(row);
  }

  /**
   * Quyền, key, dựng lại cụm, ghi audit. Kiểm key trước khi đụng dữ liệu: chưa có key thì không có gì rời máy chủ
   * và cũng không ghi audit.
   */
  private async prepare(
    viewer: AuthUser,
    projectId: string,
    clusterId: string,
    input: RunSkillAiInput,
  ) {
    await this.skills.assertProjectAccess(viewer, projectId);
    if (!isUuid(clusterId)) throw notFound('Không tìm thấy cụm');
    if (!(await this.llm.hasKey(viewer.id))) throw llmError('llm_key_missing');

    const collected = await this.skills.collect(viewer, projectId, input);
    const clusters = clusterPrompts(collected.inputs, {
      maxClusters: MAX_CLUSTERS,
    }).clusters;
    const cluster = clusters.find(
      (c) => clusterIdOf(projectId, c.fingerprint) === clusterId,
    );
    if (!cluster) throw clusterNotFound();
    const occurrences = occurrencesOf(
      collected.inputs,
      cluster.fingerprint,
      EXAMPLES_FOR_AI,
    );

    // Leader gửi prompt của người khác cho nhà cung cấp LLM: ghi audit như khi mở session của họ.
    if (
      this.access.isLeader(viewer) &&
      cluster.users.some((u) => u.userId !== viewer.id)
    ) {
      await this.audit.record(
        viewer.id,
        'skill_clusters.ai',
        'project',
        projectId,
      );
    }
    return {
      blocks: clusterBlocks(cluster, occurrences),
      // Chủ dữ liệu khi cụm chỉ gồm prompt của một người (member, hoặc leader lọc theo người).
      subjectUserId: collected.owner ?? null,
    };
  }

  /** Chuẩn hóa `result` (tên kebab-case, ghép `markdown` cho S2); `null` khi không đúng dạng. */
  private normalize(kind: string, value: unknown): Record<string, unknown> | null {
    if (kind === 'skill_triage') {
      const parsed = triageSchema.safeParse(value);
      return parsed.success ? normalizeTriage(parsed.data) : null;
    }
    const parsed = contentSchema.safeParse(value);
    return parsed.success ? normalizeContent(parsed.data) : null;
  }

  /** Lưu bản đã chuẩn hóa đè lên đầu ra thô của model rồi trả `AiResult`. */
  private async finish(row: AiResultRow): Promise<AiResult> {
    const normalized = this.normalize(row.kind, row.result);
    if (normalized) {
      await this.db
        .update(aiResults)
        .set({ result: normalized })
        .where(eq(aiResults.id, row.id));
    }
    return toAiResult({ ...row, result: normalized ?? row.result });
  }

  /** Đổi sang `AiResult` và chuẩn hóa lại khi đọc (bản lưu bởi phiên bản cũ, hoặc đã chuẩn hóa rồi thì giữ nguyên). */
  private toResult(row: AiResultRow): AiResult {
    const normalized = this.normalize(row.kind, row.result);
    return toAiResult({ ...row, result: normalized ?? row.result });
  }
}
