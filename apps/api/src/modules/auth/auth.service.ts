import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { ApiError } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import { randomToken, sha256 } from '../../common/crypto.js';
import { hashPassword, verifyPassword } from '../../common/passwords.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  authSessions,
  type ProjectRole,
  projectMembers,
  projects,
  type User,
  users,
} from '../../db/schema/index.js';

export const SESSION_COOKIE = 'tl_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Chỉ cập nhật `last_used_at` khi đã cũ hơn mức này, tránh ghi DB mỗi request. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function toAuthUser(
  user: Pick<User, 'id' | 'email' | 'name' | 'isAdmin'>,
): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin,
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface Membership {
  projectId: string;
  projectName: string;
  projectSlug: string;
  role: ProjectRole;
}

@Injectable()
export class AuthService {
  /** Hash giả để so khi email không tồn tại, giữ thời gian phản hồi tương đương. */
  private dummyHash?: Promise<string>;

  constructor(@Inject(DB) private readonly db: Database) {}

  async needsSetup(): Promise<boolean> {
    const [row] = await this.db.select({ n: count() }).from(users);
    return row.n === 0;
  }

  /** Tạo admin đầu tiên. Chỉ được gọi khi chưa có user nào. */
  async setup(input: {
    email: string;
    name: string;
    password: string;
  }): Promise<AuthUser> {
    const passwordHash = await hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      // Khóa để hai request /setup đồng thời không cùng tạo admin.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('teamlens:setup'))`,
      );
      const [row] = await tx.select({ n: count() }).from(users);
      if (row.n > 0) {
        throw new ApiError(409, 'already_setup', 'Server đã được cài đặt');
      }
      const [user] = await tx
        .insert(users)
        .values({
          email: normalizeEmail(input.email),
          name: input.name.trim(),
          passwordHash,
          isAdmin: true,
        })
        .returning();
      return toAuthUser(user);
    });
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
    if (!user) {
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
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(eq(projectMembers.userId, userId))
      .orderBy(asc(projects.name));
  }
}
