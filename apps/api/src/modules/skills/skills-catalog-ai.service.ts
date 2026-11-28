import { Inject, Injectable } from '@nestjs/common';
import type { AiResult, CatalogPicksSaved } from '@teamlens/schema';
import { eq } from 'drizzle-orm';
import { ApiError } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { aiResults } from '../../db/schema/index.js';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import { llmError } from '../llm/llm-errors.js';
import { LlmService, toAiResult } from '../llm/llm.service.js';
import type { AiLocale, AiResultRow } from '../llm/llm.types.js';
import { shortlist } from './catalog-shortlist.js';
import { clusterPrompts } from './prompt-clusterer.js';
import { SkillCatalogService } from './skill-catalog.service.js';
import {
  CANDIDATES_FOR_AI,
  CATALOG_PROMPT_VERSION,
  CLUSTERS_FOR_PICKS,
  normalizePicks,
  PICKS_SYSTEM,
  pickBlocks,
  picksSchema,
} from './skills-catalog-prompts.js';
import type { RunSkillAiInput } from './skills-ai.service.js';
import { SkillsService } from './skills.service.js';

/**
 * S3 (M6.13): AI chọn tối đa 5 skill trong catalog cộng đồng hợp với các workflow lặp lại của người bấm.
 *
 * Cụm dựng lại ở server như `SkillsAiService` (cùng quyền, cùng audit `skill_clusters.ai` khi leader dùng prompt của
 * người khác). Catalog đọc từ GitHub qua `SkillCatalogService`, lọc sơ rồi gửi cho LLM bằng key của người bấm. Kết quả
 * AI chỉ là mã ứng viên: server tự điền tên, mô tả, đường dẫn từ catalog và bỏ mã không có trong danh sách.
 */
@Injectable()
export class SkillsCatalogAiService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(SkillCatalogService) private readonly catalog: SkillCatalogService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LlmService) private readonly llm: LlmService,
  ) {}

  /** Kết quả đã lưu của chính người gọi. Không đụng dữ liệu prompt nên không ghi audit. */
  async saved(
    viewer: AuthUser,
    projectId: string,
    locale: AiLocale,
  ): Promise<CatalogPicksSaved> {
    await this.skills.assertProjectAccess(viewer, projectId);
    const rows = await this.llm.findResults(viewer.id, {
      subjectType: 'project',
      subjectIds: [projectId],
      kind: 'catalog_picks',
      locale,
    });
    return { result: rows[0] ? toAiResult(rows[0]) : null };
  }

  async run(
    viewer: AuthUser,
    projectId: string,
    input: RunSkillAiInput,
    locale: AiLocale,
  ): Promise<AiResult> {
    await this.skills.assertProjectAccess(viewer, projectId);
    // Kiểm key trước khi đụng dữ liệu hay gọi GitHub: chưa có key thì không có gì rời máy chủ và không audit.
    if (!(await this.llm.hasKey(viewer.id))) throw llmError('llm_key_missing');

    const collected = await this.skills.collect(viewer, projectId, input);
    const clusters = clusterPrompts(collected.inputs, {
      maxClusters: CLUSTERS_FOR_PICKS,
    }).clusters;
    if (clusters.length === 0)
      throw new ApiError(
        409,
        'no_clusters',
        'Chưa có prompt nào lặp lại đủ 3 lần trong khoảng này nên chưa có gì để đối chiếu với catalog.',
      );

    const { entries } = await this.catalog.load();
    const candidates = shortlist(
      entries,
      clusters.map((c) => c.label),
      CANDIDATES_FOR_AI,
    );

    // Nhãn cụm là nội dung prompt: leader gửi prompt của người khác cho nhà cung cấp LLM thì ghi audit.
    if (
      this.access.isLeader(viewer) &&
      clusters.some((c) => c.users.some((u) => u.userId !== viewer.id))
    ) {
      await this.audit.record(
        viewer.id,
        'skill_clusters.ai',
        'project',
        projectId,
      );
    }

    const row = await this.llm.run(viewer.id, {
      kind: 'catalog_picks',
      subjectType: 'project',
      subjectId: projectId,
      subjectUserId: collected.owner ?? null,
      locale,
      promptVersion: CATALOG_PROMPT_VERSION,
      system: PICKS_SYSTEM,
      untrusted: pickBlocks(clusters, candidates),
      schema: picksSchema,
      maxOutputTokens: 1200,
    });
    return this.finish(row, candidates);
  }

  /** Lưu bản đã lọc (mã hợp lệ, tên và đường dẫn từ catalog) đè lên đầu ra thô của model rồi trả `AiResult`. */
  private async finish(
    row: AiResultRow,
    candidates: Parameters<typeof normalizePicks>[1],
  ): Promise<AiResult> {
    const parsed = picksSchema.safeParse(row.result);
    if (!parsed.success) return toAiResult(row);
    const normalized = normalizePicks(parsed.data, candidates);
    await this.db
      .update(aiResults)
      .set({ result: normalized })
      .where(eq(aiResults.id, row.id));
    return toAiResult({ ...row, result: normalized });
  }
}
