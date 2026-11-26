import { createRequire } from 'node:module';
import type { IngestBatch } from '@teamlens/schema';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

const require = createRequire(import.meta.url);
// ajv-formats là CommonJS (`module.exports = plugin`): nạp bằng require cho khỏi lệch kiểu default import.
const addFormats = require('ajv-formats') as (ajv: Ajv2020) => Ajv2020;
const sessionSchema =
  require('@teamlens/schema/session.v1.schema.json') as object;

/** Các `schema_version` server hỗ trợ. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];
/** Phiên bản `tl` tối thiểu gửi được schema server hỗ trợ (trả kèm lỗi 426). */
export const MIN_CLI_VERSION = '0.1.0';

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
addFormats(ajv);
const validate = ajv.compile<IngestBatch>(sessionSchema);

function describe(error: ErrorObject): string {
  // Chỉ in đường dẫn + thông điệp của ajv, KHÔNG in giá trị (có thể là nội dung prompt).
  return `${error.instancePath || '/'} ${error.message ?? 'không hợp lệ'}`;
}

export type ValidationResult =
  { ok: true; batch: IngestBatch } | { ok: false; message: string };

/** Validate batch theo `session.v1.schema.json` (draft 2020-12). */
export function validateIngestBatch(body: unknown): ValidationResult {
  if (validate(body)) return { ok: true, batch: body };
  const details = (validate.errors ?? []).slice(0, 5).map(describe).join('; ');
  return { ok: false, message: `Batch không hợp lệ: ${details}` };
}

/**
 * Đọc `schema_version` trước khi validate chi tiết. Trả về số phiên bản nếu là số nguyên
 * KHÔNG được hỗ trợ (→ 426); `null` nếu được hỗ trợ hoặc không phải số nguyên (để ajv báo 400).
 */
export function unsupportedSchemaVersion(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const version = (body as { schema_version?: unknown }).schema_version;
  if (typeof version !== 'number' || !Number.isInteger(version)) return null;
  return SUPPORTED_SCHEMA_VERSIONS.includes(version) ? null : version;
}
