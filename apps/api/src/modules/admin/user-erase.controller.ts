import { Controller, Delete, Inject, Param } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/auth-context.js';
import { LeaderOnly } from '../access/access.guards.js';
import { UserEraseService, type UserErasure } from './user-erase.service.js';

/** Xóa toàn bộ dữ liệu của một người (M5.6, chỉ leader). */
@Controller('api/v1/admin/users')
export class UserEraseController {
  constructor(
    @Inject(UserEraseService) private readonly erasure: UserEraseService,
  ) {}

  @Delete(':userId')
  @LeaderOnly()
  erase(
    @CurrentUser() user: AuthUser,
    @Param('userId') userId: string,
  ): Promise<UserErasure> {
    return this.erasure.erase(user, userId);
  }
}
