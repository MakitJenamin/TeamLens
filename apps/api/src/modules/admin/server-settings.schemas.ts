import { z } from 'zod';

const utf8Bytes = (value: string) => Buffer.byteLength(value, 'utf8');

/**
 * Id pattern = nhãn CLI hiện trong `[REDACTED:<id>]`. CLI (`kind_from_id` ở
 * `cli/crates/tl-core/src/redact.rs`) bỏ `_` ở hai đầu và bỏ hẳn pattern có id rỗng, nên id
 * không được bắt đầu hay kết thúc bằng `_`.
 */
export const patternIdSchema = z
  .string()
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$/,
    'id chỉ gồm a-z, 0-9, _ và không bắt đầu hay kết thúc bằng _',
  );

export const redactionPatternSchema = z
  .object({
    id: patternIdSchema,
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    regex: z
      .string()
      .min(1)
      .refine(
        (value) => utf8Bytes(value) <= 4096,
        'regex tối đa 4096 byte UTF-8',
      ),
  })
  .strict();

export type RedactionPatternInput = z.infer<typeof redactionPatternSchema>;

export const updateSettingsSchema = z
  .object({
    redactionPatterns: z
      .array(redactionPatternSchema)
      .max(50)
      .refine(
        (items) => new Set(items.map((i) => i.id)).size === items.length,
        'id pattern phải duy nhất',
      )
      .optional(),
    expectedRedactionPatternsVersion: z.string().min(1).max(64).optional(),
    retentionDays: z.number().int().min(7).max(730).nullable().optional(),
    expectedRetentionVersion: z.string().min(1).max(64).optional(),
    consentText: z.string().min(1).max(50_000).optional(),
    expectedConsentVersion: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Cần ít nhất một thay đổi')
  .refine(
    (value) =>
      value.consentText === undefined ||
      value.expectedConsentVersion !== undefined,
    'Sửa văn bản đồng ý cần expectedConsentVersion',
  )
  .refine(
    (value) =>
      value.redactionPatterns === undefined ||
      value.expectedRedactionPatternsVersion !== undefined,
    'Sửa pattern cần expectedRedactionPatternsVersion',
  )
  .refine(
    (value) =>
      value.retentionDays === undefined ||
      value.expectedRetentionVersion !== undefined,
    'Sửa retention cần expectedRetentionVersion',
  );

export const testPatternSchema = z
  .object({
    id: patternIdSchema,
    regex: z
      .string()
      .min(1)
      .refine(
        (value) => utf8Bytes(value) <= 4096,
        'regex tối đa 4096 byte UTF-8',
      ),
    sample: z.string().max(4096),
  })
  .strict();
