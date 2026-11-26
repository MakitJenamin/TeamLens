import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiError,
  isUniqueViolation,
  notFound,
} from '../../common/api-error.js';
import { type AuthUser, CurrentUser } from '../../common/auth-context.js';
import { hashPassword } from '../../common/passwords.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { USER_ROLES, users } from '../../db/schema/index.js';
import { LeaderOnly } from '../access/access.guards.js';
import { isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import { normalizeEmail, toAuthUser } from '../auth/auth.service.js';

const passwordSchema = z
  .string()
  .min(8, 'Mật khẩu phải có ít nhất 8 ký tự')
  .max(200);

const createLeaderSchema = z.object({
  email: z.email('Email không hợp lệ').max(254),
  name: z.string().trim().min(1, 'Tên không được để trống').max(100),
  password: passwordSchema,
});

const updateRoleSchema = z.object({
  role: z.enum(USER_ROLES, 'Vai trò phải là leader hoặc member'),
  email: z.email('Email không hợp lệ').max(254).optional(),
  password: passwordSchema.optional(),
});

const emailTaken = () =>
  new ApiError(409, 'email_taken', 'Email đã được dùng cho tài khoản khác');

/** Quản lý tài khoản và vai trò (chỉ leader, SPEC 11.1). */
@Controller('api/v1/users')
@LeaderOnly()
export class UsersController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(): Promise<AuthUser[]> {
    const rows = await this.db
      .select()
      .from(users)
      .where(isNull(users.deletedAt))
      .orderBy(asc(users.name));
    return rows.map(toAuthUser);
  }

  /** Thêm leader khác (có email + mật khẩu). Member tự tham gia bằng link mời. */
  @Post()
  async create(
    @CurrentUser() actor: AuthUser,
    @Body({ schema: createLeaderSchema })
    body: z.infer<typeof createLeaderSchema>,
  ): Promise<AuthUser> {
    const passwordHash = await hashPassword(body.password);
    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            email: normalizeEmail(body.email),
            name: body.name,
            passwordHash,
            role: 'leader',
          })
          .returning();
        await this.audit.record(actor.id, 'user.create', 'user', user.id, tx);
        return toAuthUser(user);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw emailTaken();
      throw error;
    }
  }

  /**
   * Đổi vai trò. Nâng lên leader cần email + mật khẩu nếu user chưa có;
   * không cho hạ leader cuối cùng (khóa các dòng leader để hai request song song không cùng lọt).
   */
  @Patch(':userId')
  async updateRole(
    @CurrentUser() actor: AuthUser,
    @Param('userId') userId: string,
    @Body({ schema: updateRoleSchema }) body: z.infer<typeof updateRoleSchema>,
  ): Promise<AuthUser> {
    if (!isUuid(userId)) throw notFound('Không tìm thấy người dùng');
    const passwordHash = body.password
      ? await hashPassword(body.password)
      : undefined;
    try {
      return await this.db.transaction(async (tx) => {
        const [target] = await tx
          .select()
          .from(users)
          .where(and(eq(users.id, userId), isNull(users.deletedAt)))
          .for('update');
        if (!target) throw notFound('Không tìm thấy người dùng');

        if (body.role === 'member' && target.role === 'leader') {
          const leaders = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.role, 'leader'), isNull(users.deletedAt)))
            .for('update');
          if (leaders.length <= 1) {
            throw new ApiError(
              409,
              'last_leader',
              'Server phải còn ít nhất một leader',
            );
          }
        }

        const patch: Partial<typeof users.$inferInsert> = { role: body.role };
        if (body.role === 'leader') {
          const email = body.email
            ? normalizeEmail(body.email)
            : target.email;
          const hash = passwordHash ?? target.passwordHash;
          if (!email || !hash) {
            throw new ApiError(
              400,
              'credentials_required',
              'Nâng lên leader cần email và mật khẩu để đăng nhập dashboard',
            );
          }
          patch.email = email;
          patch.passwordHash = hash;
        }

        const [updated] = await tx
          .update(users)
          .set(patch)
          .where(eq(users.id, userId))
          .returning();
        await this.audit.record(
          actor.id,
          'user.role_change',
          'user',
          userId,
          tx,
        );
        return toAuthUser(updated);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw emailTaken();
      throw error;
    }
  }
}
