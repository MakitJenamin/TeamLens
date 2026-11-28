import { Controller, Get, Inject, Param } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/auth-context.js';
import { FindingsService } from './findings.service.js';

@Controller('api/v1/sessions')
export class FindingsController {
  constructor(
    @Inject(FindingsService) private readonly findings: FindingsService,
  ) {}

  @Get(':sessionId/findings')
  list(@CurrentUser() user: AuthUser, @Param('sessionId') sessionId: string) {
    return this.findings.list(user, sessionId);
  }
}
