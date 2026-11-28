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

export const REDACTION_KEY = 'redaction_patterns';
export const RETENTION_KEY = 'retention_days';
export const DEFAULT_RETENTION_DAYS = 90;

export interface ServerSettingsUpdate {
  redactionPatterns?: RedactionPatternInput[];
  retentionDays?: number | null;
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
    const rows = await this.db.select().from(settings);
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
      retentionDays: retention
        ? (retention.value as number | null)
        : DEFAULT_RETENTION_DAYS,
      consentText,
      affectedDevices: active?.n ?? 0,
    };
  }

  private async assertPatterns(patterns: RegexInput[]): Promise<void> {
    if (patterns.length === 0) return;
    const result = await this.regex.check(patterns);
    if (!result.ok) {
      throw new ApiError(
        400,
        'pattern_invalid',
        `Pattern "${result.id}" không hợp lệ theo cú pháp regex của Rust.`,
      );
    }
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
            {
              from: current.version,
              to: version,
            },
          );
        }
      }
      if (input.redactionPatterns) {
        const value = input.redactionPatterns;
        await tx
          .insert(settings)
          .values({ key: REDACTION_KEY, value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });
        // Chỉ ghi số lượng và ID, không ghi regex.
        await this.audit.record(
          user.id,
          'settings.redaction_patterns.update',
          'settings',
          REDACTION_KEY,
          tx,
          {
            count: value.length,
            ids: value.map((p) => p.id),
          },
        );
      }
      if (input.retentionDays !== undefined) {
        const [before] = await tx
          .select()
          .from(settings)
          .where(eq(settings.key, RETENTION_KEY));
        const from = before
          ? (before.value as number | null)
          : DEFAULT_RETENTION_DAYS;
        // `null` lưu thành jsonb 'null' (vô hạn), khác với chưa cấu hình (mặc định 90 ngày).
        const value =
          input.retentionDays === null
            ? sql`'null'::jsonb`
            : input.retentionDays;
        await tx
          .insert(settings)
          .values({ key: RETENTION_KEY, value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });
        await this.audit.record(
          user.id,
          'settings.retention.update',
          'settings',
          RETENTION_KEY,
          tx,
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
    if (!result.ok)
      throw new ApiError(
        400,
        'pattern_invalid',
        'Pattern không hợp lệ theo cú pháp regex của Rust.',
      );
    return { matches: result.matches, redacted: result.redacted ?? '' };
  }
}
