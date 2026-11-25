import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { asc, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiError,
  forbidden,
  isUniqueViolation,
} from '../../common/api-error.js';
import { type AuthUser, CurrentUser } from '../../common/auth-context.js';
import { hashPassword } from '../../common/passwords.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { users } from '../../db/schema/index.js';
import { AuditService } from '../access/audit.service.js';
import { normalizeEmail, toAuthUser } from '../auth/auth.service.js';

const createUserSchema = z.object({
  email: z.email('Email không hợp lệ').max(254),
  name: z.string().trim().min(1, 'Tên không được để trống').max(100),
  password: z.string().min(8, 'Mật khẩu phải có ít nhất 8 ký tự').max(200),
  isAdmin: z.boolean().optional(),
});

/** Quản lý tài khoản (chỉ admin). */
@Controller('api/v1/users')
export class UsersController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentUser() actor: AuthUser): Promise<AuthUser[]> {
    if (!actor.isAdmin) throw forbidden();
    const rows = await this.db
      .select()
      .from(users)
      .where(isNull(users.deletedAt))
      .orderBy(asc(users.email));
    return rows.map(toAuthUser);
  }

  @Post()
  async create(
    @CurrentUser() actor: AuthUser,
    @Body({ schema: createUserSchema }) body: z.infer<typeof createUserSchema>,
  ): Promise<AuthUser> {
    if (!actor.isAdmin) throw forbidden();
    const passwordHash = await hashPassword(body.password);
    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            email: normalizeEmail(body.email),
            name: body.name,
            passwordHash,
            isAdmin: body.isAdmin ?? false,
          })
          .returning();
        await this.audit.record(actor.id, 'user.create', 'user', user.id, tx);
        return toAuthUser(user);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(
          409,
          'email_taken',
          'Email đã được dùng cho tài khoản khác',
        );
      }
      throw error;
    }
  }
}
