import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LlmKey } from '@teamlens/schema';
import { eq } from 'drizzle-orm';
import { ApiError } from '../../common/api-error.js';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { userLlmKeys } from '../../db/schema/index.js';
import { decryptSecret, encryptSecret } from './key-crypto.js';
import { llmError } from './llm-errors.js';
import type { LlmKeyConfig, LlmProvider } from './llm.types.js';

export interface SaveLlmKeyInput {
  provider: LlmProvider;
  baseUrl?: string | null;
  model: string;
  /** Bỏ trống (undefined) khi đã có key = giữ key cũ. Chuỗi rỗng chỉ hợp lệ với `openai_compatible`. */
  apiKey?: string;
}

/** Số ký tự cuối của key lưu ở `key_hint`; key quá ngắn thì không lưu gợi ý. */
const HINT_LENGTH = 4;

function keyHint(apiKey: string): string {
  return apiKey.length >= HINT_LENGTH * 2 ? apiKey.slice(-HINT_LENGTH) : '';
}

function validationError(message: string): ApiError {
  return new ApiError(400, 'validation_error', message);
}

/**
 * API key LLM của từng người (BYO, bảng `user_llm_keys`), mã hóa AES-256-GCM bằng `TEAMLENS_SECRET_KEY`.
 * Không bao giờ trả key nguyên văn ra ngoài module (`getDecryptedKey` chỉ dùng nội bộ để gọi provider).
 */
@Injectable()
export class LlmKeyService {
  private readonly logger = new Logger(LlmKeyService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get secret(): string {
    return this.config.get('TEAMLENS_SECRET_KEY', { infer: true });
  }

  /** Cấu hình key của userId theo dạng `LlmKey` của contract, hoặc null nếu chưa có. */
  async getKeyInfo(userId: string): Promise<LlmKey | null> {
    const [row] = await this.db
      .select()
      .from(userLlmKeys)
      .where(eq(userLlmKeys.userId, userId));
    if (!row) return null;
    return {
      provider: row.provider,
      baseUrl: row.baseUrl,
      model: row.model,
      keyHint: row.keyHint ? `…${row.keyHint}` : '',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Lưu (tạo hoặc sửa) key của userId. Không kiểm tra với provider; muốn kiểm tra dùng `LlmService.testKey`. */
  async saveKey(userId: string, input: SaveLlmKeyInput): Promise<LlmKey> {
    const model = input.model.trim();
    if (!model) throw validationError('Cần nhập tên model');
    const baseUrl = input.baseUrl?.trim() || null;
    if (input.provider === 'openai_compatible' && !baseUrl) {
      throw validationError(
        'Provider openai_compatible cần baseUrl, ví dụ http://localhost:11434/v1',
      );
    }
    const apiKey = input.apiKey?.trim();

    if (
      apiKey === undefined ||
      (apiKey === '' && input.provider !== 'openai_compatible')
    ) {
      // Không gửi key mới: chỉ hợp lệ khi đã có key, giữ key cũ.
      const [existing] = await this.db
        .select({ userId: userLlmKeys.userId })
        .from(userLlmKeys)
        .where(eq(userLlmKeys.userId, userId));
      if (!existing) throw validationError('Cần nhập API key');
      await this.db
        .update(userLlmKeys)
        .set({
          provider: input.provider,
          baseUrl,
          model,
          updatedAt: new Date(),
        })
        .where(eq(userLlmKeys.userId, userId));
    } else {
      const values = {
        provider: input.provider,
        baseUrl,
        model,
        keyEncrypted: encryptSecret(apiKey, this.secret),
        keyHint: keyHint(apiKey),
      };
      await this.db
        .insert(userLlmKeys)
        .values({ userId, ...values })
        .onConflictDoUpdate({
          target: userLlmKeys.userId,
          set: { ...values, updatedAt: new Date() },
        });
    }
    const saved = await this.getKeyInfo(userId);
    if (!saved) throw new Error('Không đọc lại được key vừa lưu');
    return saved;
  }

  async deleteKey(userId: string): Promise<void> {
    await this.db.delete(userLlmKeys).where(eq(userLlmKeys.userId, userId));
  }

  async hasKey(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: userLlmKeys.userId })
      .from(userLlmKeys)
      .where(eq(userLlmKeys.userId, userId));
    return Boolean(row);
  }

  /**
   * Cấu hình để kiểm tra key (`POST /api/v1/me/llm-key/test`): trường nào thiếu lấy từ key đã lưu.
   * Không có key đã lưu mà thiếu trường thì ném `llm_key_missing` (thiếu apiKey) hoặc 400 (thiếu model/baseUrl).
   */
  async resolveTestConfig(
    userId: string,
    partial: Partial<SaveLlmKeyInput>,
  ): Promise<LlmKeyConfig> {
    const saved = await this.getDecryptedKey(userId);
    const provider = partial.provider ?? saved?.provider;
    const model = partial.model?.trim() || saved?.model;
    const apiKey = partial.apiKey ?? saved?.apiKey;
    const baseUrl =
      partial.baseUrl !== undefined
        ? partial.baseUrl?.trim() || null
        : (saved?.baseUrl ?? null);
    if (apiKey === undefined) throw llmError('llm_key_missing');
    if (!provider) throw validationError('Cần chọn provider');
    if (!model) throw validationError('Cần nhập tên model');
    if (provider === 'openai_compatible' && !baseUrl) {
      throw validationError('Provider openai_compatible cần baseUrl');
    }
    return { provider, baseUrl, model, apiKey: apiKey.trim() };
  }

  /** Cấu hình key đã giải mã, hoặc null nếu chưa có. Chỉ dùng nội bộ module `llm`. */
  async getDecryptedKey(userId: string): Promise<LlmKeyConfig | null> {
    const [row] = await this.db
      .select()
      .from(userLlmKeys)
      .where(eq(userLlmKeys.userId, userId));
    if (!row) return null;
    let apiKey: string;
    try {
      apiKey = decryptSecret(row.keyEncrypted, this.secret);
    } catch {
      this.logger.warn(
        'Không giải mã được LLM key đã lưu (TEAMLENS_SECRET_KEY đã đổi?)',
      );
      throw llmError(
        'llm_key_missing',
        'Không đọc được API key đã lưu, hãy nhập lại key trong "Cài đặt AI"',
      );
    }
    return {
      provider: row.provider,
      baseUrl: row.baseUrl,
      model: row.model,
      apiKey,
    };
  }
}
