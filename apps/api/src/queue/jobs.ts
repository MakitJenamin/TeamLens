/** Tên các job pg-boss và kiểu payload tương ứng. */
export const JOBS = {
  /** Phát sau khi ingest xong một session (M1.6); worker chấm rule nhận job này (M1.11). */
  sessionIngested: 'session.ingested',
  /** Leader bấm "Chạy lại" (M2.8): chấm lại mọi session của một project. */
  projectRescore: 'project.rescore',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface JobPayloads {
  'session.ingested': { sessionId: string };
  'project.rescore': { projectId: string };
}
