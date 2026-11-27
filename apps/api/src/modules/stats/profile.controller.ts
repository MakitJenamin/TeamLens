import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { type AuthUser, CurrentUser } from '../../common/auth-context.js';
import { ProfileService } from './profile.service.js';

const isoDateTime = z.iso
  .datetime({ offset: true, message: 'Phải là thời điểm ISO 8601' })
  .transform((value) => new Date(value));

export const profileQuerySchema = z.object({
  project: z.uuid('project phải là UUID'),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

/** Hồ sơ thành viên (M2.10; contract `stats.yaml`). Leader xem mọi người (có audit), member xem của mình. */
@Controller('api/v1/users/:userId')
export class ProfileController {
  constructor(@Inject(ProfileService) private readonly profile: ProfileService) {}

  @Get('profile')
  get(
    @CurrentUser() user: AuthUser,
    @Param('userId') userId: string,
    @Query({ schema: profileQuerySchema })
    query: z.infer<typeof profileQuerySchema>,
  ) {
    return this.profile.get(user, userId, query);
  }
}
