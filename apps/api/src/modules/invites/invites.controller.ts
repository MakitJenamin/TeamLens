import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../common/api-error.js';
import {
  type AuthUser,
  CurrentUser,
  Public,
} from '../../common/auth-context.js';
import type { Env } from '../../config/env.js';
import { LeaderOnly } from '../access/access.guards.js';
import { IngestRateLimiter } from '../agent/rate-limiter.js';
import { DeviceService } from '../device/device.service.js';
import { INVITE_CODE_RE, inviteNotFound } from './invite-status.js';
import { renderInstallScript } from './install-script.js';
import { InvitesService } from './invites.service.js';

/** Giới hạn cho các endpoint công khai (xem trước, join, `install.ps1`), tính chung theo IP. */
export const PUBLIC_INVITE_LIMIT_PER_MINUTE = 10;

/** Bộ đếm riêng cho endpoint công khai của link mời (khóa theo IP). */
export class InviteRateLimiter extends IngestRateLimiter {}

export const createInviteSchema = z
  .object({
    expiresInDays: z.int().min(1).max(30).optional(),
    maxUses: z.int().min(1).max(1000).nullable().optional(),
  })
  .optional();

export const joinSchema = z.object({
  code: z.string().min(10).max(100),
  name: z.string().trim().min(1, 'Tên không được để trống').max(100),
  deviceName: z.string().trim().min(1, 'Thiếu tên thiết bị').max(100),
  os: z.string().trim().min(1, 'Thiếu hệ điều hành').max(50),
  cliVersion: z.string().trim().min(1, 'Thiếu phiên bản CLI').max(50),
  consent: z.object({
    textVersion: z.string().min(1).max(100),
    backfill: z.boolean(),
  }),
});

const invalidToken = () =>
  new ApiError(
    401,
    'invalid_token',
    'Token thiết bị không hợp lệ hoặc đã bị thu hồi',
  );

/** Tính một lượt gọi của IP vào bộ đếm công khai; quá giới hạn thì 429 kèm `Retry-After`. */
function hitPublicLimit(
  limiter: InviteRateLimiter,
  req: Request,
  res: Response,
): void {
  const retryAfter = limiter.hit(
    req.ip ?? req.socket.remoteAddress ?? 'unknown',
    PUBLIC_INVITE_LIMIT_PER_MINUTE,
  );
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    throw new ApiError(429, 'rate_limited', 'Thử lại sau ít phút.');
  }
}

/** Quản lý link mời trên dashboard (chỉ leader). */
@Controller('api/v1/projects/:projectId/invites')
@LeaderOnly()
export class DashboardInvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Get()
  list(@Param('projectId') projectId: string) {
    return this.invites.list(projectId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body({ schema: createInviteSchema })
    body: z.infer<typeof createInviteSchema>,
  ) {
    return this.invites.create(user, projectId, body ?? {});
  }

  @Delete(':inviteId')
  @HttpCode(204)
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('inviteId') inviteId: string,
  ): Promise<void> {
    await this.invites.revoke(user, projectId, inviteId);
  }
}

/** Endpoint công khai cho `tl join`. */
@Controller('agent/v1')
export class AgentInvitesController {
  constructor(
    private readonly invites: InvitesService,
    private readonly devices: DeviceService,
    private readonly limiter: InviteRateLimiter,
  ) {}

  @Public()
  @Get('invites/:code')
  preview(
    @Param('code') code: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.limit(req, res);
    return this.invites.preview(code);
  }

  @Public()
  @Post('join')
  async join(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: joinSchema }) body: z.infer<typeof joinSchema>,
  ) {
    this.limit(req, res);
    // Có header Authorization thì phải là device token hợp lệ (máy đã tham gia).
    let existing = null;
    const header = req.headers.authorization;
    if (header !== undefined) {
      const match = /^Bearer\s+(\S+)$/i.exec(header);
      if (!match) throw invalidToken();
      existing = await this.devices.authenticate(match[1]);
      if (!existing) throw invalidToken();
    }
    const { created, result } = await this.invites.join(body, existing);
    res.status(created ? 201 : 200);
    return result;
  }

  private limit(req: Request, res: Response): void {
    hitPublicLimit(this.limiter, req, res);
  }
}

/**
 * Script cài đặt công khai cho `irm <server>/install.ps1?code=<mã> | iex` (M3.6, contract
 * `invites.yaml`). Không kiểm tra link còn dùng được (việc của `tl join`), chỉ kiểm tra định dạng mã.
 */
@Controller()
export class InstallScriptController {
  private readonly publicUrl: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly limiter: InviteRateLimiter,
  ) {
    this.publicUrl = config.get('TEAMLENS_PUBLIC_URL', { infer: true });
  }

  @Public()
  @Get('install.ps1')
  script(
    @Query('code') code: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): string {
    hitPublicLimit(this.limiter, req, res);
    if (typeof code !== 'string' || !INVITE_CODE_RE.test(code)) {
      throw inviteNotFound();
    }
    // Đặt header ở đây (không dùng @Header) để lỗi phía trên vẫn trả JSON đúng kiểu.
    res.type('text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return renderInstallScript({ publicUrl: this.publicUrl, code });
  }
}
