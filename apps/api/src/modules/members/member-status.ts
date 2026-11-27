import type { DeviceStatus } from '../../db/schema/devices.js';
import { effectiveDeviceStatus } from '../agent/heartbeat.js';

/** Dòng thành viên đọc từ DB (`project_members` + `users` + session gần nhất). */
export interface MemberRow {
  userId: string;
  name: string;
  email: string | null;
  role: 'leader' | 'member';
  joinedAt: Date;
  lastSessionAt: Date | null;
}

/** Dòng thiết bị đọc từ DB (`devices`), `status` là giá trị thô trong cột. */
export interface DeviceRow {
  id: string;
  userId: string;
  name: string;
  os: string;
  cliVersion: string;
  status: DeviceStatus;
  lastSeenAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface MemberDeviceDto {
  id: string;
  name: string;
  os: string;
  cliVersion: string;
  status: DeviceStatus;
  lastSeenAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

/** `MemberStatus` trong contract `members.yaml`. */
export interface MemberStatusDto extends MemberRow {
  devices: MemberDeviceDto[];
}

const time = (value: Date | null) => value?.getTime() ?? -Infinity;

/**
 * Ghép thành viên với thiết bị của họ. `status` của thiết bị là trạng thái hiệu lực
 * (`effectiveDeviceStatus`: heartbeat cũ hơn 30 phút thì offline). Thành viên: tham gia
 * gần nhất trước; thiết bị: chưa thu hồi trước, rồi `lastSeenAt` mới nhất, rồi `createdAt`.
 */
export function buildMemberStatus(
  members: MemberRow[],
  deviceRows: DeviceRow[],
  now: Date = new Date(),
): MemberStatusDto[] {
  const byUser = new Map<string, MemberDeviceDto[]>();
  for (const { userId, status, ...device } of deviceRows) {
    const list = byUser.get(userId) ?? [];
    list.push({
      ...device,
      status: effectiveDeviceStatus(status, device.lastSeenAt, now),
    });
    byUser.set(userId, list);
  }
  for (const list of byUser.values()) {
    list.sort(
      (a, b) =>
        Number(a.revokedAt !== null) - Number(b.revokedAt !== null) ||
        time(b.lastSeenAt) - time(a.lastSeenAt) ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }
  return [...members]
    .sort(
      (a, b) =>
        b.joinedAt.getTime() - a.joinedAt.getTime() ||
        a.name.localeCompare(b.name),
    )
    .map((member) => ({ ...member, devices: byUser.get(member.userId) ?? [] }));
}
