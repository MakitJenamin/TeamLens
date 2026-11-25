import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import { z } from 'zod';
import {
  type AuthRequest,
  type AuthUser,
  CurrentUser,
  Public,
} from '../../common/auth-context.js';
import type { Env } from '../../config/env.js';
import { AuthService, SESSION_COOKIE, SESSION_TTL_MS } from './auth.service.js';

const setupSchema = z.object({
  email: z.email('Email không hợp lệ').max(254),
  name: z.string().trim().min(1, 'Tên không được để trống').max(100),
  password: z.string().min(8, 'Mật khẩu phải có ít nhất 8 ký tự').max(200),
});

const loginSchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(200),
});

@Controller()
export class AuthController {
  private readonly secureCookie: boolean;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    this.secureCookie = config
      .get('TEAMLENS_PUBLIC_URL', { infer: true })
      .startsWith('https');
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: this.secureCookie,
    };
  }

  private async startSession(res: Response, user: AuthUser): Promise<void> {
    const { token } = await this.auth.createSession(user.id);
    res.cookie(SESSION_COOKIE, token, {
      ...this.cookieOptions(),
      maxAge: SESSION_TTL_MS,
    });
  }

  @Public()
  @Get('api/v1/setup/status')
  async setupStatus(): Promise<{ needsSetup: boolean }> {
    return { needsSetup: await this.auth.needsSetup() };
  }

  @Public()
  @Post('api/v1/setup')
  async setup(
    @Body({ schema: setupSchema }) body: z.infer<typeof setupSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthUser }> {
    const user = await this.auth.setup(body);
    await this.startSession(res, user);
    return { user };
  }

  @Public()
  @Post('api/v1/auth/login')
  @HttpCode(200)
  async login(
    @Body({ schema: loginSchema }) body: z.infer<typeof loginSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthUser }> {
    const user = await this.auth.verifyCredentials(body.email, body.password);
    await this.startSession(res, user);
    return { user };
  }

  @Post('api/v1/auth/logout')
  @HttpCode(204)
  async logout(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (req.authSessionId) await this.auth.deleteSession(req.authSessionId);
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  @Get('api/v1/auth/me')
  async me(@CurrentUser() user: AuthUser) {
    return { user, memberships: await this.auth.getMemberships(user.id) };
  }
}
