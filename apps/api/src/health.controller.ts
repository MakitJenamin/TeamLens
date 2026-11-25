import { Controller, Get } from '@nestjs/common';
import { Public } from './common/auth-context.js';

@Controller()
export class HealthController {
  @Public()
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
