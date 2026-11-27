import type { Schemas } from "@teamlens/schema";

/** Kiểu lấy từ contract `GET /users/{userId}/profile` (`stats.yaml`). */
export type MemberProfile = Schemas["MemberProfile"];
export type ProfilePattern = Schemas["ProfilePattern"];
export type ProfileWeek = Schemas["ProfileWeek"];

/** Hồ sơ mặc định xem 2 tuần gần nhất (khớp mặc định của API). */
export const PROFILE_DEFAULT_WEEKS = 2;
/** Số session gần nhất hiện ở cuối hồ sơ. */
export const RECENT_SESSIONS = 5;
