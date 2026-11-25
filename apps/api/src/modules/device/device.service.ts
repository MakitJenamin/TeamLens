import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  ApiError,
  forbidden,
  isUniqueViolation,
  notFound,
} from '../../common/api-error.js';
import type { AuthDevice, AuthUser } from '../../common/auth-context.js';
import { randomToken, sha256 } from '../../common/crypto.js';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  deviceCodes,
  devices,
  projectMembers,
  projectRepos,
  projects,
  users,
} from '../../db/schema/index.js';
import { isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import { toAuthUser } from '../auth/auth.service.js';
import { generateUserCode, normalizeUserCode } from './user-code.js';

/** Thời gian sống của device code: 15 phút. */
export const DEVICE_CODE_TTL_SECONDS = 900;
/** Khoảng cách tối thiểu giữa hai lần poll /device/token. */
export const POLL_INTERVAL_SECONDS = 5;
export const DEVICE_TOKEN_PREFIX = 'tld_';
/**
 * Code đã được duyệt vẫn đổi được token trong khoảng này sau `expiresAt`
 * (user duyệt sát giờ hết hạn, CLI chưa kịp poll).
 */
export const APPROVED_GRACE_SECONDS = 5 * 60;
/** Chỉ ghi `last_seen_at` khi giá trị cũ đã quá mức này, tránh ghi DB mỗi request. */
export const LAST_SEEN_TOUCH_SECONDS = 5 * 60;

const tokenError = (error: string, message: string) =>
  new ApiError(400, error, message);
const expiredToken = () =>
  tokenError(
    'expired_token',
    'Mã thiết bị không hợp lệ hoặc đã hết hạn, hãy chạy lại `tl login`',
  );

export interface DeviceDto {
  id: string;
  name: string;
  os: string;
  cliVersion: string;
  status: string;
  lastSeenAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

@Injectable()
export class DeviceService {
  private readonly publicUrl: string;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.publicUrl = config.get('TEAMLENS_PUBLIC_URL', { infer: true });
  }

  /** Bước 1: CLI xin device code + user code. */
  async createCode(input: {
    deviceName: string;
    os: string;
    cliVersion: string;
  }) {
    const deviceCode = randomToken();
    const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000);
    // Va chạm user code rất hiếm (20^8 tổ hợp), vẫn thử lại vài lần cho chắc.
    for (let attempt = 0; ; attempt++) {
      const userCode = generateUserCode();
      try {
        await this.db.insert(deviceCodes).values({
          deviceCodeHash: sha256(deviceCode),
          userCode,
          deviceName: input.deviceName,
          os: input.os,
          cliVersion: input.cliVersion,
          expiresAt,
        });
        const verificationUri = `${this.publicUrl}/device`;
        return {
          deviceCode,
          userCode,
          verificationUri,
          verificationUriComplete: `${verificationUri}?code=${userCode}`,
          expiresIn: DEVICE_CODE_TTL_SECONDS,
          interval: POLL_INTERVAL_SECONDS,
        };
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= 4) throw error;
      }
    }
  }

  /**
   * Bước 3: CLI poll lấy token. Token chỉ được sinh và trả về đúng một lần, ngay khi CLI
   * nhận (sau khi đã duyệt); DB chỉ giữ SHA-256 nên không cần lưu token gốc ở đâu cả.
   */
  async pollToken(
    deviceCode: string,
  ): Promise<{ accessToken: string; deviceId: string }> {
    const [row] = await this.db
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.deviceCodeHash, sha256(deviceCode)))
      .limit(1);
    if (!row || row.status === 'consumed') throw expiredToken();

    const now = new Date();
    const tooFast =
      row.lastPolledAt !== null &&
      now.getTime() - row.lastPolledAt.getTime() < POLL_INTERVAL_SECONDS * 1000;
    await this.db
      .update(deviceCodes)
      .set({ lastPolledAt: now })
      .where(eq(deviceCodes.id, row.id));
    if (tooFast) {
      throw tokenError(
        'slow_down',
        `Poll quá nhanh, hãy chờ ít nhất ${POLL_INTERVAL_SECONDS} giây`,
      );
    }
    if (row.status === 'denied') {
      throw tokenError(
        'access_denied',
        'Yêu cầu đăng nhập thiết bị đã bị từ chối',
      );
    }
    if (row.status === 'pending') {
      if (row.expiresAt <= now) throw expiredToken();
      throw tokenError(
        'authorization_pending',
        'Đang chờ xác nhận mã trên trình duyệt',
      );
    }

    // status === 'approved'. Quá thời gian grace: thu hồi thiết bị đã tạo lúc duyệt
    // (chưa từng có token) để không để lại thiết bị mồ côi, rồi báo hết hạn.
    const graceEnd = row.expiresAt.getTime() + APPROVED_GRACE_SECONDS * 1000;
    if (now.getTime() > graceEnd) {
      await this.db.transaction(async (tx) => {
        const [expired] = await tx
          .update(deviceCodes)
          .set({ status: 'consumed' })
          .where(
            and(eq(deviceCodes.id, row.id), eq(deviceCodes.status, 'approved')),
          )
          .returning();
        if (expired?.deviceId) {
          await tx
            .update(devices)
            .set({ revokedAt: now })
            .where(
              and(
                eq(devices.id, expired.deviceId),
                isNull(devices.tokenHash),
                isNull(devices.revokedAt),
              ),
            );
        }
      });
      throw expiredToken();
    }

    // status === 'approved': đổi sang consumed rồi mới sinh token (chống trả token hai lần).
    return this.db.transaction(async (tx) => {
      const [consumed] = await tx
        .update(deviceCodes)
        .set({ status: 'consumed' })
        .where(
          and(eq(deviceCodes.id, row.id), eq(deviceCodes.status, 'approved')),
        )
        .returning();
      if (!consumed?.deviceId) throw expiredToken();
      const accessToken = DEVICE_TOKEN_PREFIX + randomToken();
      await tx
        .update(devices)
        .set({ tokenHash: sha256(accessToken), lastSeenAt: now })
        .where(eq(devices.id, consumed.deviceId));
      return { accessToken, deviceId: consumed.deviceId };
    });
  }

  /** Bước 2: user đã đăng nhập dashboard nhập user code để duyệt thiết bị. */
  async approve(user: AuthUser, rawUserCode: string) {
    const invalid = () =>
      new ApiError(404, 'invalid_code', 'Mã không đúng hoặc đã được dùng');
    const userCode = normalizeUserCode(rawUserCode);
    if (!userCode) throw invalid();
    const [row] = await this.db
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.userCode, userCode))
      .limit(1);
    if (!row || row.status !== 'pending') throw invalid();
    if (row.expiresAt <= new Date()) {
      throw new ApiError(
        410,
        'expired_code',
        'Mã đã hết hạn, hãy chạy lại `tl login`',
      );
    }

    return this.db.transaction(async (tx) => {
      const [device] = await tx
        .insert(devices)
        .values({
          userId: user.id,
          name: row.deviceName,
          os: row.os,
          cliVersion: row.cliVersion,
        })
        .returning();
      const [approved] = await tx
        .update(deviceCodes)
        .set({ status: 'approved', userId: user.id, deviceId: device.id })
        .where(
          and(eq(deviceCodes.id, row.id), eq(deviceCodes.status, 'pending')),
        )
        .returning();
      if (!approved) throw invalid();
      return { device: { id: device.id, name: device.name } };
    });
  }

  async listOwn(userId: string): Promise<DeviceDto[]> {
    return this.db
      .select({
        id: devices.id,
        name: devices.name,
        os: devices.os,
        cliVersion: devices.cliVersion,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
        createdAt: devices.createdAt,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .where(eq(devices.userId, userId))
      .orderBy(desc(devices.createdAt));
  }

  /** Thu hồi thiết bị: token không còn dùng được. Chủ thiết bị hoặc admin. */
  async revoke(actor: AuthUser, deviceId: string): Promise<void> {
    if (!isUuid(deviceId)) throw notFound('Không tìm thấy thiết bị');
    const [device] = await this.db
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (!device) throw notFound('Không tìm thấy thiết bị');
    if (device.userId !== actor.id && !actor.isAdmin) throw forbidden();
    if (device.revokedAt) return;
    await this.db.transaction(async (tx) => {
      await tx
        .update(devices)
        .set({ revokedAt: new Date(), tokenHash: null })
        .where(eq(devices.id, deviceId));
      await this.audit.record(
        actor.id,
        'device.revoke',
        'device',
        deviceId,
        tx,
      );
    });
  }

  /** Xác thực device token. Hợp lệ thì cập nhật `last_seen_at`. */
  async authenticate(
    token: string,
  ): Promise<{ user: AuthUser; device: AuthDevice } | null> {
    if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
    const [row] = await this.db
      .select({ device: devices, user: users })
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .where(
        and(
          eq(devices.tokenHash, sha256(token)),
          isNull(devices.revokedAt),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    const lastSeen = row.device.lastSeenAt?.getTime() ?? 0;
    if (Date.now() - lastSeen > LAST_SEEN_TOUCH_SECONDS * 1000) {
      await this.db
        .update(devices)
        .set({ lastSeenAt: new Date() })
        .where(eq(devices.id, row.device.id));
    }
    return {
      user: toAuthUser(row.user),
      device: {
        id: row.device.id,
        name: row.device.name,
        userId: row.device.userId,
      },
    };
  }

  /** Thông tin cho `tl status`: user, thiết bị, project và pattern repo. */
  async whoami(user: AuthUser, device: AuthDevice) {
    const memberships = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(eq(projectMembers.userId, user.id))
      .orderBy(asc(projects.name));
    const repos = memberships.length
      ? await this.db
          .select({
            projectId: projectRepos.projectId,
            pattern: projectRepos.remotePattern,
          })
          .from(projectRepos)
          .where(
            inArray(
              projectRepos.projectId,
              memberships.map((m) => m.id),
            ),
          )
          .orderBy(asc(projectRepos.remotePattern))
      : [];
    return {
      user: { id: user.id, email: user.email, name: user.name },
      device: { id: device.id, name: device.name },
      projects: memberships.map((project) => ({
        ...project,
        repoPatterns: repos
          .filter((r) => r.projectId === project.id)
          .map((r) => r.pattern),
      })),
    };
  }
}
