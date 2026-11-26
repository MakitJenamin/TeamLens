import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { forbidden, notFound } from '../../common/api-error.js';
import type { AuthDevice, AuthUser } from '../../common/auth-context.js';
import { randomToken, sha256 } from '../../common/crypto.js';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  devices,
  projectMembers,
  projectRepos,
  projects,
  users,
  webLoginTickets,
} from '../../db/schema/index.js';
import { isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import { toAuthUser } from '../auth/auth.service.js';

export const DEVICE_TOKEN_PREFIX = 'tld_';
/** Thời gian sống của ticket đăng nhập dashboard cho `tl open`. */
export const WEB_LOGIN_TTL_SECONDS = 60;
/** Chỉ ghi `last_seen_at` khi giá trị cũ đã quá mức này, tránh ghi DB mỗi request. */
export const LAST_SEEN_TOUCH_SECONDS = 5 * 60;

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

  /** Thu hồi thiết bị: token không còn dùng được. Chủ thiết bị hoặc leader. */
  async revoke(actor: AuthUser, deviceId: string): Promise<void> {
    if (!isUuid(deviceId)) throw notFound('Không tìm thấy thiết bị');
    const [device] = await this.db
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (!device) throw notFound('Không tìm thấy thiết bị');
    if (device.userId !== actor.id && actor.role !== 'leader')
      throw forbidden();
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

  /**
   * `tl open`: tạo ticket đăng nhập dashboard một lần (60 giây). DB chỉ lưu SHA-256;
   * web đổi ticket qua `POST /api/v1/auth/ticket`.
   */
  async createWebLoginTicket(
    user: AuthUser,
    device: AuthDevice,
  ): Promise<{ url: string; expiresIn: number }> {
    const ticket = randomToken();
    await this.db.insert(webLoginTickets).values({
      id: sha256(ticket),
      userId: user.id,
      deviceId: device.id,
      expiresAt: new Date(Date.now() + WEB_LOGIN_TTL_SECONDS * 1000),
    });
    return {
      url: `${this.publicUrl}/auth/cli?ticket=${ticket}`,
      expiresIn: WEB_LOGIN_TTL_SECONDS,
    };
  }

  /** Thông tin cho `tl status`: user, thiết bị, project và pattern repo. */
  async whoami(user: AuthUser, device: AuthDevice) {
    const memberships = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
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
      role: user.role,
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
