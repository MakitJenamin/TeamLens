import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { type AuthDevice, CurrentDevice } from '../../common/auth-context.js';
import { ConsentService } from './consent.service.js';

export const consentUpdateSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('grant'),
    textVersion: z.string().min(1, 'textVersion không được để trống'),
    backfill: z.boolean('backfill phải là true hoặc false'),
  }),
  z.strictObject({ action: z.literal('revoke') }),
]);

/**
 * `GET`/`POST /agent/v1/consent` (contract `packages/schema/openapi/consent.yaml`, JSON camelCase).
 * Xác thực bằng `DeviceAuthGuard` toàn cục.
 */
@Controller('agent/v1/consent')
export class ConsentController {
  constructor(@Inject(ConsentService) private readonly consent: ConsentService) {}

  @Get()
  get(@CurrentDevice() device: AuthDevice) {
    return this.consent.status(device);
  }

  @Post()
  @HttpCode(200)
  update(
    @CurrentDevice() device: AuthDevice,
    @Body({ schema: consentUpdateSchema })
    body: z.infer<typeof consentUpdateSchema>,
  ) {
    return this.consent.update(device, body);
  }
}
