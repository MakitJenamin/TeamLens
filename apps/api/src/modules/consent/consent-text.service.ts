import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { settings } from '../../db/schema/index.js';

export const CONSENT_TEXT_KEY = 'consent_text';
export interface CurrentConsentText { version: string; text: string }

/** Nguồn runtime duy nhất cho văn bản đồng ý, trong bảng settings. */
export async function readConsentText(db: Pick<Database, 'select'>): Promise<CurrentConsentText> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, CONSENT_TEXT_KEY));
  const value = row?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof (value as Record<string, unknown>).version !== 'string' ||
      typeof (value as Record<string, unknown>).text !== 'string') {
    throw new Error('Thiếu settings.consent_text; hãy chạy migration.');
  }
  return value as unknown as CurrentConsentText;
}

@Injectable()
export class ConsentTextService {
  constructor(@Inject(DB) private readonly db: Database) {}
  get(db: Pick<Database, 'select'> = this.db) { return readConsentText(db); }
}
