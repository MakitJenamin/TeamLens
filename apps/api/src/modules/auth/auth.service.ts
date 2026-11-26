import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Schemas } from '@teamlens/schema';
import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { ApiError, isUniqueViolation } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import { randomToken, sha256 } from '../../common/crypto.js';
import { hashPassword, verifyPassword } from '../../common/passwords.js';
import { normalizeRemotePattern } from '../../common/remote-pattern.js';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  authSessions,
  projectMembers,
  projectRepos,
  projects,
  type User,
  users,
  webLoginTickets,
} from '../../db/schema/index.js';
import { AuditService } from '../access/audit.service.js';
import {
  type CreatedInviteDto,
  insertInvite,
} from '../invites/invite-factory.js';

export const SESSION_COOKIE = 'tl_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Chỉ cập nhật `last_used_at` khi đã cũ hơn mức này, tránh ghi DB mỗi request. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function toAuthUser(
  user: Pick<User, 'id' | 'email' | 'name' | 'role'>,
): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Chuẩn hóa repo pattern của wizard setup; sai thì 400 `invalid_pattern`. */
export function normalizePatternOrThrow(raw: string): string {
  const pattern = normalizeRemotePattern(raw);
  if (!pattern) {
    throw new ApiError(
      400,
      'invalid_pattern',
      `Pattern không hợp lệ: "${raw}". Cần dạng host/org/repo hoặc host/org/*`,
    );
  }
  return pattern;
}

export interface SetupProjectInput {
  name: string;
  slug: string;
  repoPatterns: string[];
}

export interface SetupResult {
  user: AuthUser;
  project?: Schemas['ProjectDetail'];
  invite?: CreatedInviteDto;
}

const invalidTicket = () =>
  new ApiError(
    401,
    'invalid_ticket',
    'Link đăng nhập đã hết hạn hoặc đã dùng. Chạy lại `tl open`.',
  );

export interface Membership {
  projectId: string;
  projectName: string;
  projectSlug: string;
}

@Injectable()
export class AuthService {
  /** Hash giả để so khi email không tồn tại, giữ thời gian phản hồi tương đương. */
  private dummyHash?: Promise<string>;

  private readonly publicUrl: string;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.publicUrl = config.get('TEAMLENS_PUBLIC_URL', { infer: true });
  }

  async needsSetup(): Promise<boolean> {
    const [row] = await this.db.select({ n: count() }).from(users);
    return row.n === 0;
  }

  /**
   * Tạo leader đầu tiên. Chỉ được gọi khi chưa có user nào.
   * Wizard gửi kèm `project`: cùng transaction tạo project, repo pattern, leader làm thành viên
   * và một link mời mặc định (7 ngày, không giới hạn lượt).
   */
  async setup(input: {
    email: string;
    name: string;
    password: string;
    project?: SetupProjectInput;
  }): Promise<SetupResult> {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db.transaction(async (tx) => {
        // Khóa để hai request /setup đồng thời không cùng tạo leader.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('teamlens:setup'))`,
        );
        const [row] = await tx.select({ n: count() }).from(users);
        if (row.n > 0) {
          throw new ApiError(409, 'already_setup', 'Server đã được cài đặt');
        }
        const [created] = await tx
          .insert(users)
          .values({
            email: normalizeEmail(input.email),
            name: input.name.trim(),
            passwordHash,
            role: 'leader',
          })
          .returning();
        const user = toAuthUser(created);
        if (!input.project) return { user };

        // Pattern sai ném lỗi giữa transaction: mọi thứ (kể cả leader) được rollback.
        const patterns = [
          ...new Set(input.project.repoPatterns.map(normalizePatternOrThrow)),
        ];
        const [project] = await tx
          .insert(projects)
          .values({ name: input.project.name.trim(), slug: input.project.slug })
          .returning();
        const repos = await tx
          .insert(projectRepos)
          .values(
            patterns.map((remotePattern) => ({
              projectId: project.id,
              remotePattern,
            })),
          )
          .returning({
            id: projectRepos.id,
            remotePattern: projectRepos.remotePattern,
          });
        await tx
          .insert(projectMembers)
          .values({ projectId: project.id, userId: user.id });
        await this.audit.record(
          user.id,
          'project.create',
          'project',
          project.id,
          tx,
        );
        const invite = await insertInvite(tx, this.publicUrl, {
          projectId: project.id,
          creator: user,
        });
        await this.audit.record(
          user.id,
          'invite.create',
          'invite',
          invite.invite.id,
          tx,
        );
        repos.sort((a, b) => a.remotePattern.localeCompare(b.remotePattern));
        return {
          user,
          project: {
            id: project.id,
            name: project.name,
            slug: project.slug,
            settings: project.settings,
            repos,
          },
          invite,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(
          409,
          'slug_taken',
          'Slug đã được dùng cho project khác',
        );
      }
      throw error;
    }
  }

  /**
   * Đổi ticket của `tl open` lấy user: ticket đúng, chưa dùng, chưa hết hạn. Đánh dấu đã dùng
   * bằng một câu `UPDATE ... WHERE used_at IS NULL RETURNING` nên hai request song song chỉ một
   * cái thắng.
   */
  async consumeLoginTicket(ticket: string): Promise<AuthUser> {
    const now = new Date();
    const [used] = await this.db
      .update(webLoginTickets)
      .set({ usedAt: now })
      .where(
        and(
          eq(webLoginTickets.id, sha256(ticket)),
          isNull(webLoginTickets.usedAt),
          gt(webLoginTickets.expiresAt, now),
        ),
      )
      .returning({ userId: webLoginTickets.userId });
    if (!used) throw invalidTicket();
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, used.userId), isNull(users.deletedAt)))
      .limit(1);
    if (!user) throw invalidTicket();
    return toAuthUser(user);
  }

  /** Kiểm tra email + mật khẩu. Sai thì 401 `invalid_credentials`. */
  async verifyCredentials(email: string, password: string): Promise<AuthUser> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(
        and(eq(users.email, normalizeEmail(email)), isNull(users.deletedAt)),
      )
      .limit(1);
    // Member không có mật khẩu: so với hash giả để thời gian phản hồi như email sai.
    if (!user?.passwordHash) {
      this.dummyHash ??= hashPassword(randomToken());
      await verifyPassword(await this.dummyHash, password);
    } else if (await verifyPassword(user.passwordHash, password)) {
      return toAuthUser(user);
    }
    throw new ApiError(
      401,
      'invalid_credentials',
      'Email hoặc mật khẩu không đúng',
    );
  }

  /** Tạo phiên đăng nhập mới, trả token gốc (chỉ đặt vào cookie, DB lưu SHA-256). */
  async createSession(
    userId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db
      .insert(authSessions)
      .values({ id: sha256(token), userId, expiresAt });
    return { token, expiresAt };
  }

  async validateSessionToken(
    token: string,
  ): Promise<{ user: AuthUser; sessionId: string } | null> {
    const sessionId = sha256(token);
    const [row] = await this.db
      .select({ user: users, lastUsedAt: authSessions.lastUsedAt })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(
        and(
          eq(authSessions.id, sessionId),
          gt(authSessions.expiresAt, new Date()),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (Date.now() - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db
        .update(authSessions)
        .set({ lastUsedAt: new Date() })
        .where(eq(authSessions.id, sessionId));
    }
    return { user: toAuthUser(row.user), sessionId };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.delete(authSessions).where(eq(authSessions.id, sessionId));
  }

  async getMemberships(userId: string): Promise<Membership[]> {
    return this.db
      .select({
        projectId: projects.id,
        projectName: projects.name,
        projectSlug: projects.slug,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(eq(projectMembers.userId, userId))
      .orderBy(asc(projects.name));
  }
}
