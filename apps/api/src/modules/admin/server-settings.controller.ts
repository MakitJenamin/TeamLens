import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
} from '@nestjs/common';
import type { z } from 'zod';
import { CurrentUser, type AuthUser } from '../../common/auth-context.js';
import { LeaderOnly } from '../access/access.guards.js';
import { ServerSettingsService } from './server-settings.service.js';
import {
  testPatternSchema,
  updateSettingsSchema,
} from './server-settings.schemas.js';

/** Cài đặt server (M4.6, chỉ leader). Retention chỉ lưu cấu hình; job xóa là M5.5. */
@Controller('api/v1/admin/settings')
export class ServerSettingsController {
  constructor(
    @Inject(ServerSettingsService)
    private readonly settings: ServerSettingsService,
  ) {}

  @Get()
  @LeaderOnly()
  get() {
    return this.settings.get();
  }

  @Patch()
  @LeaderOnly()
  update(
    @CurrentUser() user: AuthUser,
    @Body({ schema: updateSettingsSchema })
    body: z.infer<typeof updateSettingsSchema>,
  ) {
    return this.settings.update(user, body);
  }

  @Post('redaction-test')
  @LeaderOnly()
  @HttpCode(200)
  test(
    @Body({ schema: testPatternSchema })
    body: z.infer<typeof testPatternSchema>,
  ) {
    return this.settings.testPattern(body);
  }
}
