import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import type { HeartbeatResult } from '@teamlens/schema';
import type { Response } from 'express';
import type { z } from 'zod';
import { ApiError } from '../../common/api-error.js';
import { type AuthDevice, CurrentDevice } from '../../common/auth-context.js';
import { HeartbeatRateLimiter, heartbeatSchema } from './heartbeat.js';
import { HeartbeatService } from './heartbeat.service.js';

/**
 * `POST /agent/v1/heartbeat` (contract `packages/schema/openapi/agent.yaml`, JSON snake_case).
 * Xác thực bằng `DeviceAuthGuard` toàn cục.
 */
@Controller('agent/v1')
export class HeartbeatController {
  constructor(
    private readonly heartbeat: HeartbeatService,
    private readonly rateLimiter: HeartbeatRateLimiter,
  ) {}

  @Post('heartbeat')
  @HttpCode(200)
  heartbeatPost(
    @CurrentDevice() device: AuthDevice,
    @Body({ schema: heartbeatSchema }) body: z.infer<typeof heartbeatSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HeartbeatResult> {
    const retryAfter = this.rateLimiter.hit(device.id);
    if (retryAfter !== null) {
      res.setHeader('Retry-After', String(retryAfter));
      throw new ApiError(
        429,
        'rate_limited',
        'Gửi quá nhanh, thử lại sau ít phút.',
      );
    }
    return this.heartbeat.record(device, body);
  }
}
