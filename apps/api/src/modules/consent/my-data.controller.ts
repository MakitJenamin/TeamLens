import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../../common/auth-context.js';
import { MyDataService } from './my-data.service.js';

const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(20).max(100).default(20),
});

@Controller('api/v1/me')
export class MyDataController {
  constructor(@Inject(MyDataService) private readonly data: MyDataService) {}

  @Get('consents')
  consents(@CurrentUser() user: AuthUser) {
    return this.data.consents(user.id);
  }

  @Get('session-views')
  views(@CurrentUser() user: AuthUser, @Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    return this.data.views(user.id, query);
  }
}
