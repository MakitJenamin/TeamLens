import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AiResult } from '@teamlens/schema';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { aiResults } from '../../db/schema/index.js';
import {
  LLM_ADAPTERS,
  LLM_TIMEOUT_MS,
  type LlmAdapters,
  type LlmCompletion,
} from './adapters/adapter.js';
import { LlmKeyService } from './llm-key.service.js';
import { llmError, llmErrorCode } from './llm-errors.js';
import type {
  AiResultRow,
  FindResultsFilter,
  LlmKeyConfig,
  LlmTask,
} from './llm.types.js';
import { buildPrompt, parseJsonOutput, type BuiltPrompt } from './prompt.js';

export const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
/** Số lần thử lại khi đầu ra sai schema. */
const BAD_OUTPUT_RETRIES = 1;

const TEST_SCHEMA = z.object({ ok: z.boolean() });

/** JSON Schema để ép provider, từ schema zod của task. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<
    string,
    unknown
  >;
  return rest;
}

/** Đổi bản ghi `ai_results` sang dạng `AiResult` của contract. */
export function toAiResult(row: AiResultRow): AiResult {
  return {
    id: row.id,
    kind: row.kind as AiResult['kind'],
    subjectType: row.subjectType as AiResult['subjectType'],
    subjectId: row.subjectId,
    locale: row.locale as AiResult['locale'],
    provider: row.provider as AiResult['provider'],
    model: row.model,
    promptVersion: row.promptVersion,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    result: row.result as AiResult['result'],
    createdAt: row.createdAt.toISOString(),
  };
}

function sumTokens(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
}

/**
 * Lõi gọi LLM (AI_PLAN mục 3): mọi tính năng AI gọi qua đây, với key BYO của chính người bấm.
 * Không log prompt hay key; chỉ log kind, model, số token, thời gian.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly timeoutMs: number;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly keys: LlmKeyService,
    @Inject(LLM_ADAPTERS) private readonly adapters: LlmAdapters,
    @Optional() @Inject(LLM_TIMEOUT_MS) timeoutMs?: number,
  ) {
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Gọi LLM bằng key của userId, validate đầu ra bằng `task.schema` (sai thì thử lại 1 lần),
   * upsert `ai_results` (ghi đè bản cũ cùng người bấm + kind + đối tượng + locale) và trả bản đã lưu.
   * Ném `ApiError` mã `llm_*` khi lỗi.
   */
  async run<T>(userId: string, task: LlmTask<T>): Promise<AiResultRow<T>> {
    const key = await this.keys.getDecryptedKey(userId);
    if (!key) throw llmError('llm_key_missing');

    const jsonSchema = toJsonSchema(task.schema);
    const prompt = buildPrompt({
      system: task.system,
      untrusted: task.untrusted,
      locale: task.locale,
      jsonSchema,
    });
    const started = Date.now();
    const { value, completions } = await this.completeValidated(
      key,
      prompt,
      jsonSchema,
      task.schema,
      task.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      task.kind,
    );
    const inputTokens = sumTokens(completions.map((c) => c.inputTokens));
    const outputTokens = sumTokens(completions.map((c) => c.outputTokens));

    const fields = {
      subjectUserId: task.subjectUserId ?? null,
      provider: key.provider,
      model: key.model,
      promptVersion: task.promptVersion,
      inputTokens,
      outputTokens,
      result: value as unknown,
      createdAt: new Date(),
    };
    const [row] = await this.db
      .insert(aiResults)
      .values({
        userId,
        kind: task.kind,
        subjectType: task.subjectType,
        subjectId: task.subjectId,
        locale: task.locale,
        ...fields,
      })
      .onConflictDoUpdate({
        target: [
          aiResults.userId,
          aiResults.kind,
          aiResults.subjectType,
          aiResults.subjectId,
          aiResults.locale,
        ],
        set: fields,
      })
      .returning();

    this.logger.log(
      `kind=${task.kind} model=${key.model} in=${inputTokens ?? '?'} out=${outputTokens ?? '?'} attempts=${completions.length} ms=${Date.now() - started}`,
    );
    return { ...row, result: value };
  }

  /** Kiểm tra cấu hình key bằng một câu ngắn ép schema `{ ok: boolean }`. Không lưu gì. */
  async testKey(cfg: LlmKeyConfig): Promise<{ latencyMs: number }> {
    const jsonSchema = toJsonSchema(TEST_SCHEMA);
    const prompt = buildPrompt({
      system:
        'This is a connectivity test. Reply with {"ok": true} and nothing else.',
      untrusted: [],
      locale: 'en',
      jsonSchema,
    });
    const started = Date.now();
    await this.completeValidated(
      cfg,
      prompt,
      jsonSchema,
      TEST_SCHEMA,
      64,
      'test',
    );
    return { latencyMs: Date.now() - started };
  }

  /** Kết quả AI của chính userId cho các đối tượng đã cho. */
  async findResults(
    userId: string,
    filter: FindResultsFilter,
  ): Promise<AiResultRow[]> {
    if (filter.subjectIds.length === 0) return [];
    const conditions: SQL[] = [
      eq(aiResults.userId, userId),
      eq(aiResults.subjectType, filter.subjectType),
      inArray(aiResults.subjectId, filter.subjectIds),
    ];
    if (filter.kind) conditions.push(eq(aiResults.kind, filter.kind));
    if (filter.locale) conditions.push(eq(aiResults.locale, filter.locale));
    return this.db
      .select()
      .from(aiResults)
      .where(and(...conditions));
  }

  hasKey(userId: string): Promise<boolean> {
    return this.keys.hasKey(userId);
  }

  /** Gọi provider, parse và validate; sai schema thì thử lại, vẫn sai thì `llm_bad_output`. */
  private async completeValidated<T>(
    key: LlmKeyConfig,
    prompt: BuiltPrompt,
    jsonSchema: Record<string, unknown>,
    schema: z.ZodType<T>,
    maxOutputTokens: number,
    label: string,
  ): Promise<{ value: T; completions: LlmCompletion[] }> {
    const completions: LlmCompletion[] = [];
    for (let attempt = 0; attempt <= BAD_OUTPUT_RETRIES; attempt++) {
      const completion = await this.callAdapter(
        key,
        prompt,
        jsonSchema,
        maxOutputTokens,
      );
      completions.push(completion);
      let parsed: unknown;
      try {
        parsed = parseJsonOutput(completion.text);
      } catch {
        this.logger.warn(
          `kind=${label} model=${key.model} đầu ra không phải JSON (lần ${attempt + 1})`,
        );
        continue;
      }
      const result = schema.safeParse(parsed);
      if (result.success) return { value: result.data, completions };
      this.logger.warn(
        `kind=${label} model=${key.model} đầu ra sai schema (lần ${attempt + 1}): ${result.error.issues.length} lỗi`,
      );
    }
    throw llmError('llm_bad_output');
  }

  /** Một lần gọi adapter có timeout; lỗi lạ bọc thành `llm_provider_error`. */
  private async callAdapter(
    key: LlmKeyConfig,
    prompt: BuiltPrompt,
    jsonSchema: Record<string, unknown>,
    maxOutputTokens: number,
  ): Promise<LlmCompletion> {
    const adapter = this.adapters[key.provider];
    if (!adapter) {
      throw llmError(
        'llm_provider_error',
        `Chưa hỗ trợ provider ${key.provider}`,
      );
    }
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(llmError('llm_timeout'));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([
        adapter.complete({
          baseUrl: key.baseUrl,
          model: key.model,
          apiKey: key.apiKey,
          system: prompt.system,
          user: prompt.user,
          jsonSchema,
          maxOutputTokens,
          signal: controller.signal,
        }),
        timeout,
      ]);
    } catch (error) {
      if (controller.signal.aborted) throw llmError('llm_timeout');
      if (llmErrorCode(error)) throw error;
      this.logger.warn(
        `Lỗi lạ khi gọi provider ${key.provider}: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      throw llmError('llm_provider_error');
    } finally {
      clearTimeout(timer);
    }
  }
}
