/** Tên các job pg-boss và kiểu payload tương ứng. */
export const JOBS = {
  /** Phát sau khi ingest xong một session (A6); worker chấm rule nhận job này (B7). */
  sessionIngested: 'session.ingested',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface JobPayloads {
  'session.ingested': { sessionId: string };
}
