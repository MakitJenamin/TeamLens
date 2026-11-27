import type { Device } from "@teamlens/schema";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** "Mới tham gia" = tham gia project trong 7 ngày gần đây. */
export const RECENT_JOIN_DAYS = 7;

export type DeviceBadge =
  | { key: "online"; variant: "default" }
  | { key: "paused"; variant: "secondary" }
  | { key: "consentRevoked"; variant: "destructive" }
  | { key: "revoked"; variant: "outline" }
  | { key: "neverSeen"; variant: "outline" }
  | { key: "offlineRecent"; variant: "outline" }
  | { key: "offlineHours" | "offlineDays"; variant: "outline"; count: number };

/**
 * Nhãn trạng thái của một thiết bị. `device.status` đã là trạng thái hiệu lực từ API
 * (`member-status`); thiết bị đã thu hồi luôn hiện "Đã thu hồi". Offline tính thời gian từ
 * `lastSeenAt`: dưới 1 giờ, N giờ (< 1 ngày) hoặc N ngày; chưa từng kết nối khi `null`.
 */
export function deviceBadge(
  device: Pick<Device, "status" | "lastSeenAt" | "revokedAt">,
  now: Date,
): DeviceBadge {
  if (device.revokedAt) return { key: "revoked", variant: "outline" };
  switch (device.status) {
    case "online":
      return { key: "online", variant: "default" };
    case "paused":
      return { key: "paused", variant: "secondary" };
    case "consent_revoked":
      return { key: "consentRevoked", variant: "destructive" };
    case "offline": {
      if (!device.lastSeenAt) return { key: "neverSeen", variant: "outline" };
      const ago = Math.max(0, now.getTime() - new Date(device.lastSeenAt).getTime());
      if (ago < HOUR_MS) return { key: "offlineRecent", variant: "outline" };
      if (ago < DAY_MS) return { key: "offlineHours", variant: "outline", count: Math.floor(ago / HOUR_MS) };
      return { key: "offlineDays", variant: "outline", count: Math.floor(ago / DAY_MS) };
    }
  }
}

/** Thành viên tham gia project trong `RECENT_JOIN_DAYS` ngày gần đây. */
export function isRecentJoin(joinedAt: string, now: Date): boolean {
  return now.getTime() - new Date(joinedAt).getTime() <= RECENT_JOIN_DAYS * DAY_MS;
}
