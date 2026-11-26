import { z } from 'zod';
import type { DeviceStatus } from '../../db/schema/devices.js';
import { IngestRateLimiter } from './rate-limiter.js';

/** Chu kỳ heartbeat của daemon (spec 4.1). */
export const HEARTBEAT_INTERVAL_MS = 15 * 60_000;

/**
 * Không có heartbeat quá 30 phút (hai chu kỳ) thì coi thiết bị là offline.
 * "offline" tính khi đọc bằng `effectiveDeviceStatus`, không có job ghi vào DB:
 * cột `devices.status` chỉ giữ trạng thái thiết bị tự báo (online/paused) hoặc `consent_revoked`.
 */
export const DEVICE_OFFLINE_AFTER_MS = 30 * 60_000;

/** Giới hạn heartbeat: 20 request/phút mỗi thiết bị (contract `agent.yaml`). */
export const HEARTBEAT_LIMIT_PER_MINUTE = 20;

/** Bộ đếm riêng của heartbeat (không ăn vào quota ingest). */
export class HeartbeatRateLimiter extends IngestRateLimiter {
  override hit(deviceId: string, limit = HEARTBEAT_LIMIT_PER_MINUTE) {
    return super.hit(deviceId, limit);
  }
}

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Body `POST /agent/v1/heartbeat` (snake_case, `HeartbeatRequest` trong contract). */
export const heartbeatSchema = z.strictObject({
  status: z.enum(['online', 'paused']),
  cli_version: z.string().trim().min(1).max(32),
  agents: z
    .array(
      z.strictObject({
        agent: z.enum([
          'claude_code',
          'codex',
          'copilot_vscode',
          'antigravity',
        ]),
        version: z.string().max(64).nullable(),
        files: count,
      }),
    )
    .max(16),
  parse_errors: count,
  queue: z.strictObject({
    batches: count,
    bytes: count,
    dropped: count,
    failed: count,
  }),
  sent_at: z.iso.datetime({ offset: true }),
});

export type HeartbeatBody = z.infer<typeof heartbeatSchema>;

/**
 * Trạng thái hiển thị của thiết bị: `consent_revoked` luôn thắng; còn lại, chưa từng
 * heartbeat hoặc heartbeat cuối cũ hơn `DEVICE_OFFLINE_AFTER_MS` thì `offline`.
 * Trang thành viên (M4.2) dùng hàm này thay cho đọc thẳng `devices.status`.
 */
export function effectiveDeviceStatus(
  status: DeviceStatus,
  lastSeenAt: Date | null,
  now: Date = new Date(),
): DeviceStatus {
  if (status === 'consent_revoked') return status;
  if (!lastSeenAt) return 'offline';
  if (now.getTime() - lastSeenAt.getTime() > DEVICE_OFFLINE_AFTER_MS) {
    return 'offline';
  }
  return status;
}
