import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Schemas } from '@teamlens/schema';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { ApiError, notFound } from '../../common/api-error.js';
import type { AuthDevice, AuthUser } from '../../common/auth-context.js';
import { randomToken, sha256 } from '../../common/crypto.js';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  consents,
  devices,
  invites,
  projectMembers,
  projectRepos,
  projects,
  users,
} from '../../db/schema/index.js';
import { isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import { ConsentTextService } from '../consent/consent-text.service.js';
import { DEVICE_TOKEN_PREFIX } from '../device/device.service.js';
import {
  type CreatedInviteDto,
  type InviteDto,
  insertInvite,
  toInviteDto,
} from './invite-factory.js';
import {
  INVITE_CODE_RE,
  inviteNotFound,
  inviteStatus,
  unusableInviteError,
} from './invite-status.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type InvitePreview = Schemas['InvitePreview'];
export type JoinResult = Schemas['JoinResult'];

export interface JoinInput {
  code: string;
  name: string;
  deviceName: string;
  os: string;
  cliVersion: string;
  consent: { textVersion: string; backfill: boolean };
}

@Injectable()
export class InvitesService {
  private readonly publicUrl: string;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(ConsentTextService) private readonly consentText: ConsentTextService,
    config: ConfigService<Env, true>,
  ) {
    this.publicUrl = config.get('TEAMLENS_PUBLIC_URL', { infer: true });
  }

  // ---- Dashboard (leader) ----

  async list(projectId: string): Promise<InviteDto[]> {
    await this.findProject(projectId);
    const now = new Date();
    const rows = await this.db
      .select({
        invite: invites,
        creatorId: users.id,
        creatorEmail: users.email,
        creatorName: users.name,
      })
      .from(invites)
      .leftJoin(
        users,
        and(eq(users.id, invites.createdBy), isNull(users.deletedAt)),
      )
      .where(eq(invites.projectId, projectId))
      .orderBy(desc(invites.createdAt), desc(invites.id));
    return rows.map((r) =>
      toInviteDto(
        r.invite,
        r.creatorId
          ? {
              id: r.creatorId,
              email: r.creatorEmail,
              name: r.creatorName ?? '',
            }
          : null,
        now,
      ),
    );
  }

  async create(
    actor: AuthUser,
    projectId: string,
    input: { expiresInDays?: number; maxUses?: number | null },
  ): Promise<CreatedInviteDto> {
    await this.findProject(projectId);
    return this.db.transaction(async (tx) => {
      const created = await insertInvite(tx, this.publicUrl, {
        projectId,
        creator: actor,
        ...input,
      });
      await this.audit.record(
        actor.id,
        'invite.create',
        'invite',
        created.invite.id,
        tx,
      );
      return created;
    });
  }

  async revoke(
    actor: AuthUser,
    projectId: string,
    inviteId: string,
  ): Promise<void> {
    await this.findProject(projectId);
    if (!isUuid(inviteId)) throw notFound('Không tìm thấy link mời');
    await this.db.transaction(async (tx) => {
      const [invite] = await tx
        .select({ id: invites.id, revokedAt: invites.revokedAt })
        .from(invites)
        .where(and(eq(invites.id, inviteId), eq(invites.projectId, projectId)))
        .for('update')
        .limit(1);
      if (!invite) throw notFound('Không tìm thấy link mời');
      // Thu hồi lại link đã thu hồi: vẫn 204, không ghi audit lần nữa.
      if (invite.revokedAt) return;
      await tx
        .update(invites)
        .set({ revokedAt: new Date() })
        .where(eq(invites.id, inviteId));
      await this.audit.record(
        actor.id,
        'invite.revoke',
        'invite',
        inviteId,
        tx,
      );
    });
  }

  // ---- CLI (công khai) ----

  /** Xem trước link mời cho màn hình đồng ý của `tl join`. */
  async preview(code: string): Promise<InvitePreview> {
    if (!INVITE_CODE_RE.test(code)) throw inviteNotFound();
    const [row] = await this.db
      .select({ invite: invites, project: projects })
      .from(invites)
      .innerJoin(projects, eq(projects.id, invites.projectId))
      .where(eq(invites.codeHash, sha256(code)))
      .limit(1);
    if (!row) throw inviteNotFound();
    const unusable = unusableInviteError(inviteStatus(row.invite));
    if (unusable) throw unusable;
    return {
      serverUrl: this.publicUrl,
      project: {
        id: row.project.id,
        name: row.project.name,
        slug: row.project.slug,
      },
      repoPatterns: await this.repoPatterns(this.db, row.project.id),
      consent: await this.consentText.get(),
      expiresAt: row.invite.expiresAt.toISOString(),
    };
  }

  /**
   * Đổi mã mời + bản đồng ý lấy device token (SPEC 7.1). Một transaction, khóa dòng invite.
   * `existing` có khi request kèm device token hợp lệ: chỉ thêm user đó vào project.
   */
  async join(
    input: JoinInput,
    existing: { user: AuthUser; device: AuthDevice } | null,
  ): Promise<{ created: boolean; result: JoinResult }> {
    if (!INVITE_CODE_RE.test(input.code)) throw inviteNotFound();
    return this.db.transaction(async (tx) => {
      const [invite] = await tx
        .select()
        .from(invites)
        .where(eq(invites.codeHash, sha256(input.code)))
        .for('update')
        .limit(1);
      if (!invite) throw inviteNotFound();
      const unusable = unusableInviteError(inviteStatus(invite));
      if (unusable) throw unusable;
      const current = await this.consentText.get(tx);
      if (input.consent.textVersion !== current.version) {
        throw new ApiError(
          409,
          'consent_outdated',
          'Văn bản đồng ý đã thay đổi, hãy xem lại và đồng ý lại.',
        );
      }
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, invite.projectId))
        .limit(1);
      const projectDto = {
        id: project.id,
        name: project.name,
        slug: project.slug,
        repoPatterns: await this.repoPatterns(tx, project.id),
      };
      const now = new Date();

      if (existing) {
        const added = await tx
          .insert(projectMembers)
          .values({ projectId: project.id, userId: existing.user.id })
          .onConflictDoNothing()
          .returning();
        if (added.length > 0) {
          await this.useInvite(tx, invite.id);
          await this.audit.record(
            existing.user.id,
            'member.join',
            'project',
            `${project.id}:${existing.user.id}`,
            tx,
          );
        }
        await tx.insert(consents).values({
          userId: existing.user.id,
          deviceId: existing.device.id,
          textVersion: input.consent.textVersion,
          backfill: input.consent.backfill,
        });
        return {
          created: false,
          result: {
            userId: existing.user.id,
            deviceId: existing.device.id,
            role: existing.user.role,
            project: projectDto,
          },
        };
      }

      const [user] = await tx
        .insert(users)
        .values({ name: input.name.trim(), role: 'member' })
        .returning();
      await tx
        .insert(projectMembers)
        .values({ projectId: project.id, userId: user.id });
      const accessToken = DEVICE_TOKEN_PREFIX + randomToken();
      const [device] = await tx
        .insert(devices)
        .values({
          userId: user.id,
          name: input.deviceName.trim(),
          os: input.os.trim(),
          cliVersion: input.cliVersion.trim(),
          tokenHash: sha256(accessToken),
          lastSeenAt: now,
        })
        .returning();
      await tx.insert(consents).values({
        userId: user.id,
        deviceId: device.id,
        textVersion: input.consent.textVersion,
        backfill: input.consent.backfill,
      });
      await this.useInvite(tx, invite.id);
      await this.audit.record(
        user.id,
        'member.join',
        'project',
        `${project.id}:${user.id}`,
        tx,
      );
      return {
        created: true,
        result: {
          accessToken,
          userId: user.id,
          deviceId: device.id,
          role: user.role,
          project: projectDto,
        },
      };
    });
  }

  // ---- Nội bộ ----

  private async useInvite(tx: Tx, inviteId: string): Promise<void> {
    await tx
      .update(invites)
      .set({ usedCount: sql`${invites.usedCount} + 1` })
      .where(eq(invites.id, inviteId));
  }

  private async repoPatterns(
    db: Pick<Database, 'select'>,
    projectId: string,
  ): Promise<string[]> {
    const rows = await db
      .select({ pattern: projectRepos.remotePattern })
      .from(projectRepos)
      .where(eq(projectRepos.projectId, projectId))
      .orderBy(asc(projectRepos.remotePattern));
    return rows.map((r) => r.pattern);
  }

  private async findProject(projectId: string): Promise<void> {
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw notFound('Không tìm thấy project');
  }
}
