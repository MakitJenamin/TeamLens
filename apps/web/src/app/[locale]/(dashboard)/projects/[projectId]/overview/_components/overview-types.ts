import type { Schemas } from "@teamlens/schema";

/** Kiểu lấy từ contract `GET /projects/{projectId}/overview` (`stats.yaml`). */
export type ProjectOverview = Schemas["ProjectOverview"];
export type OverviewWeek = Schemas["OverviewWeek"];
export type ScoreCategory = Schemas["ScoreCategory"];

/** 5 nhóm kỹ năng theo thứ tự cố định: màu của mỗi nhóm không đổi khi lọc. */
export const SCORE_CATEGORIES: ScoreCategory[] = [
  "prompt_quality",
  "context",
  "correction_loop",
  "session_management",
  "verification",
];
