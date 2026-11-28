import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { ApiError } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { consents, settings } from '../../db/schema/index.js';
import { AuditService } from '../access/audit.service.js';
import {
  CONSENT_TEXT_KEY,
  readConsentText,
} from '../consent/consent-text.service.js';
import {
  RegexValidatorService,
  type RegexInput,
} from './regex-validator.service.js';
import type { RedactionPatternInput } from './server-settings.schemas.js';
import {
  DEFAULT_RETENTION_DAYS,
  readLastRetentionRun,
  RETENTION_KEY,
} from '../retention/retention-settings.js';

export const REDACTION_KEY = 'redaction_patterns';
export { DEFAULT_RETENTION_DAYS, RETENTION_KEY };

export interface ServerSettingsUpdate {
  redactionPatterns?: RedactionPatternInput[];
  expectedRedactionPatternsVersion?: string;
  retentionDays?: number | null;
  expectedRetentionVersion?: string;
  consentText?: string;
  expectedConsentVersion?: string;
}

/** Phiên bản mới dạng `YYYY-MM-DD.N`: tăng N trong cùng ngày UTC, sang ngày mới thì về `.1`. */
export function nextConsentVersion(current: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  const match = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(current);
  return match && match[1] === day
    ? `${day}.${Number(match[2]) + 1}`
    : `${day}.1`;
}

/** Phiên bản của một khóa khi chưa có dòng trong `settings`. */
export const MISSING_VERSION = '0';

/** Phiên bản mờ của một dòng `settings`: `updated_at` tính bằng micro giây (đủ chính xác hơn Date của JS). */
const versionSql = sql<string>`(extract(epoch from ${settings.updatedAt}) * 1000000)::bigint::text`;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Cài đặt toàn server (M4.6): redaction, retention, văn bản đồng ý. Không lưu key LLM ở đây. */
@Injectable()
export class ServerSettingsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RegexValidatorService)
    private readonly regex: RegexValidatorService,
  ) {}

  async get() {
    const rows = await this.db
      .select({
        key: settings.key,
        value: settings.value,
        version: versionSql,
      })
      .from(settings);
    const value = (key: string) => rows.find((row) => row.key === key);
    const patterns = value(REDACTION_KEY)?.value;
    const retention = value(RETENTION_KEY);
    const consentText = await readConsentText(this.db);
    const [active] = await this.db
      .select({ n: sql<number>`count(distinct ${consents.deviceId})::int` })
      .from(consents)
      .where(
        and(
          eq(consents.textVersion, consentText.version),
          isNull(consents.revokedAt),
          isNotNull(consents.deviceId),
        ),
      );
    return {
      redactionPatterns: Array.isArray(patterns)
        ? (patterns as RedactionPatternInput[])
        : [],
      redactionPatternsVersion:
        value(REDACTION_KEY)?.version ?? MISSING_VERSION,
      retentionDays: retention
        ? (retention.value as number | null)
        : DEFAULT_RETENTION_DAYS,
      retentionVersion: retention?.version ?? MISSING_VERSION,
      consentText,
      affectedDevices: active?.n ?? 0,
      retentionLastRun: await readLastRetentionRun(this.db),
    };
  }

  private async assertPatterns(patterns: RegexInput[]): Promise<void> {
    if (patterns.length === 0) return;
    const result = await this.regex.check(patterns);
    if (!result.ok) throw patternError(result.reason, result.id, result.error);
  }

  /**
   * Ghi một khóa `settings` nếu phiên bản client đã đọc còn đúng (optimistic concurrency).
   * Dòng đã có: khóa `FOR UPDATE` rồi so phiên bản. Chưa có: chỉ chèn khi vẫn chưa ai chèn.
   * Lệch thì 409 và cả transaction rollback. Trả giá trị cũ (`undefined` nếu chưa có dòng).
   */
  private async writeVersioned(
    tx: Tx,
    key: string,
    value: unknown,
    expected: string | undefined,
    conflict: { code: string; message: string },
  ): Promise<{ before: unknown } | undefined> {
    const fail = () => new ApiError(409, conflict.code, conflict.message);
    if (expected === MISSING_VERSION) {
      const inserted = await tx
        .insert(settings)
        .values({ key, value })
        .onConflictDoNothing()
        .returning({ key: settings.key });
      if (inserted.length === 0) throw fail();
      return undefined;
    }
    const [row] = await tx
      .select({ value: settings.value, version: versionSql })
      .from(settings)
      .where(eq(settings.key, key))
      .for('update');
    if (!row || row.version !== expected) throw fail();
    await tx
      .update(settings)
      // `clock_timestamp()` chính xác tới micro giây, khác `new Date()` (mili giây).
      .set({ value, updatedAt: sql`clock_timestamp()` })
      .where(eq(settings.key, key));
    return { before: row.value };
  }

  async update(user: AuthUser, input: ServerSettingsUpdate) {
    if (input.redactionPatterns) {
      await this.assertPatterns(
        input.redactionPatterns.map(({ id, regex }) => ({ id, regex })),
      );
    }
    await this.db.transaction(async (tx) => {
      if (input.consentText !== undefined) {
        // Khóa dòng văn bản đồng ý: hai leader sửa cùng lúc thì người sau nhận 409.
        const [row] = await tx
          .select()
          .from(settings)
          .where(eq(settings.key, CONSENT_TEXT_KEY))
          .for('update');
        const current = row?.value as
          { version: string; text: string } | undefined;
        if (!current)
          throw new ApiError(
            500,
            'consent_text_missing',
            'Thiếu văn bản đồng ý; hãy chạy migration.',
          );
        if (input.expectedConsentVersion !== current.version) {
          throw new ApiError(
            409,
            'consent_version_conflict',
            'Văn bản đồng ý đã được người khác sửa. Hãy tải lại trang.',
          );
        }
        if (input.consentText !== current.text) {
          const version = nextConsentVersion(current.version);
          await tx
            .update(settings)
            .set({
              value: { version, text: input.consentText },
              updatedAt: new Date(),
            })
            .where(eq(settings.key, CONSENT_TEXT_KEY));
          await this.audit.record(
            user.id,
            'settings.consent_text.update',
            'settings',
            CONSENT_TEXT_KEY,
            tx,
            undefined,
            {
              from: current.version,
              to: version,
            },
          );
        }
      }
      if (input.redactionPatterns) {
        const value = input.redactionPatterns;
        await this.writeVersioned(
          tx,
          REDACTION_KEY,
          value,
          input.expectedRedactionPatternsVersion,
          {
            code: 'redaction_patterns_conflict',
            message: 'Pattern đã được người khác sửa. Hãy tải lại trang.',
          },
        );
        // Chỉ ghi số lượng và ID, không ghi regex.
        await this.audit.record(
          user.id,
          'settings.redaction_patterns.update',
          'settings',
          REDACTION_KEY,
          tx,
          undefined,
          {
            count: value.length,
            ids: value.map((p) => p.id),
          },
        );
      }
      if (input.retentionDays !== undefined) {
        // `null` lưu thành jsonb 'null' (vô hạn), khác với chưa cấu hình (mặc định 90 ngày).
        const value =
          input.retentionDays === null
            ? sql`'null'::jsonb`
            : input.retentionDays;
        const before = await this.writeVersioned(
          tx,
          RETENTION_KEY,
          value,
          input.expectedRetentionVersion,
          {
            code: 'retention_conflict',
            message: 'Retention đã được người khác sửa. Hãy tải lại trang.',
          },
        );
        const from = before
          ? (before.before as number | null)
          : DEFAULT_RETENTION_DAYS;
        await this.audit.record(
          user.id,
          'settings.retention.update',
          'settings',
          RETENTION_KEY,
          tx,
          undefined,
          {
            from,
            to: input.retentionDays,
          },
        );
      }
    });
    return this.get();
  }

  async testPattern(input: { id: string; regex: string; sample: string }) {
    const result = await this.regex.check(
      [{ id: input.id, regex: input.regex }],
      input.sample,
    );
    if (!result.ok) throw patternError(result.reason, result.id, result.error);
    return { matches: result.matches, redacted: result.redacted ?? '' };
  }
}

/** Lỗi 400 cho pattern bị helper từ chối. Không đưa regex vào thông báo. */
function patternError(
  reason: 'invalid' | 'too_broad' | undefined,
  id: string,
  detail: string,
): ApiError {
  return reason === 'too_broad'
    ? new ApiError(
        400,
        'pattern_too_broad',
        `Pattern "${id}" khớp quá rộng (${detail}).`,
      )
    : new ApiError(
        400,
        'pattern_invalid',
        `Pattern "${id}" không hợp lệ theo cú pháp regex của Rust.`,
      );
}
