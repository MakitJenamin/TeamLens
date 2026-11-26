import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import type { IngestResult } from '@teamlens/schema';
import type { Response } from 'express';
import { ApiError } from '../../common/api-error.js';
import {
  type AuthDevice,
  type AuthUser,
  CurrentDevice,
  CurrentUser,
} from '../../common/auth-context.js';
import {
  MIN_CLI_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  unsupportedSchemaVersion,
  validateIngestBatch,
} from './ingest-validator.js';
import { IngestService } from './ingest.service.js';
import { IngestRateLimiter } from './rate-limiter.js';

/**
 * `POST /agent/v1/ingest` (contract `packages/schema/openapi/agent.yaml`).
 * Xác thực bằng `DeviceAuthGuard` toàn cục; body đã được `ingestBodyReader` đọc
 * (gzip, tối đa 10 MB sau giải nén) trước khi tới đây.
 */
@Controller('agent/v1')
export class IngestController {
  constructor(
    private readonly ingestService: IngestService,
    private readonly rateLimiter: IngestRateLimiter,
  ) {}

  @Post('ingest')
  @HttpCode(202)
  async ingest(
    @CurrentUser() user: AuthUser,
    @CurrentDevice() device: AuthDevice,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IngestResult | Record<string, unknown>> {
    const retryAfter = this.rateLimiter.hit(device.id);
    if (retryAfter !== null) {
      res.setHeader('Retry-After', String(retryAfter));
      throw new ApiError(
        429,
        'rate_limited',
        'Gửi quá nhanh, thử lại sau ít phút.',
      );
    }

    const version = unsupportedSchemaVersion(body);
    if (version !== null) {
      // Lỗi 426 có thêm trường ngoài { error, message } nên trả trực tiếp, không qua filter.
      res.status(426);
      return {
        error: 'unsupported_schema_version',
        message: `Phiên bản dữ liệu ${version} không được hỗ trợ. Hãy cập nhật tl lên bản ${MIN_CLI_VERSION} trở lên.`,
        supportedSchemaVersions: [...SUPPORTED_SCHEMA_VERSIONS],
        minCliVersion: MIN_CLI_VERSION,
      };
    }

    const validation = validateIngestBatch(body);
    if (!validation.ok) {
      throw new ApiError(400, 'validation_error', validation.message);
    }
    return this.ingestService.ingest(user, device, validation.batch);
  }
}
