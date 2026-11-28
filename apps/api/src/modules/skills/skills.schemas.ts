import { z } from 'zod';

/** Thời điểm ISO 8601 (như REST của dashboard), đổi sang `Date`. */
export const isoDateTime = z.iso
  .datetime({ offset: true, message: 'Phải là thời điểm ISO 8601' })
  .transform((value) => new Date(value));

export const localeSchema = z.enum(['vi', 'en'], 'locale phải là vi hoặc en');
