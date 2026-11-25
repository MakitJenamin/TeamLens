/** Tên các job pg-boss và kiểu payload tương ứng. */
export const JOBS = {
  /** Phát sau khi ingest xong một session (M1-Y2); worker chấm rule nhận job này (M1-Y4). */
  sessionIngested: 'session.ingested',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface JobPayloads {
  'session.ingested': { sessionId: string };
}
