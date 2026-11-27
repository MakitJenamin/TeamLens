import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import type {
  AgentToken,
  CreatedAgentToken,
  LlmKey,
  LlmProvider,
} from '@teamlens/schema';
import type { z } from 'zod';
import { type AuthUser, CurrentUser } from '../../common/auth-context.js';
import { LlmKeyService } from '../llm/llm-key.service.js';
import { LlmService } from '../llm/llm.service.js';
import {
  createAgentTokenSchema,
  putLlmKeySchema,
  testLlmKeySchema,
} from './ai-settings.schemas.js';
import { AgentTokensService } from './agent-tokens.service.js';

interface LlmKeyTestResult {
  ok: true;
  provider: LlmProvider;
  model: string;
  latencyMs: number;
}

/**
 * Trang "Cài đặt AI" (M6.2): API key BYO và token `tlp_` của CHÍNH người gọi (leader và member như nhau).
 * Không route nào nhận userId từ ngoài, nên không thể đụng dữ liệu của người khác.
 */
@Controller('api/v1/me')
export class AiSettingsController {
  constructor(
    private readonly keys: LlmKeyService,
    private readonly llm: LlmService,
    private readonly tokens: AgentTokensService,
  ) {}

  @Get('llm-key')
  async getKey(@CurrentUser() user: AuthUser): Promise<{ key: LlmKey | null }> {
    return { key: await this.keys.getKeyInfo(user.id) };
  }

  @Put('llm-key')
  async putKey(
    @CurrentUser() user: AuthUser,
    @Body({ schema: putLlmKeySchema }) body: z.infer<typeof putLlmKeySchema>,
  ): Promise<{ key: LlmKey }> {
    return { key: await this.keys.saveKey(user.id, body) };
  }

  @Delete('llm-key')
  @HttpCode(204)
  async deleteKey(@CurrentUser() user: AuthUser): Promise<void> {
    await this.keys.deleteKey(user.id);
  }

  /** Gọi thử provider bằng cấu hình gửi lên (trường thiếu lấy từ key đã lưu). Không lưu gì. */
  @Post('llm-key/test')
  @HttpCode(200)
  async testKey(
    @CurrentUser() user: AuthUser,
    @Body({ schema: testLlmKeySchema }) body: z.infer<typeof testLlmKeySchema>,
  ): Promise<LlmKeyTestResult> {
    const cfg = await this.keys.resolveTestConfig(user.id, body);
    const { latencyMs } = await this.llm.testKey(cfg);
    return { ok: true, provider: cfg.provider, model: cfg.model, latencyMs };
  }

  @Get('agent-tokens')
  async listTokens(
    @CurrentUser() user: AuthUser,
  ): Promise<{ tokens: AgentToken[] }> {
    return { tokens: await this.tokens.listOwn(user.id) };
  }

  @Post('agent-tokens')
  @HttpCode(201)
  createToken(
    @CurrentUser() user: AuthUser,
    @Body({ schema: createAgentTokenSchema })
    body: z.infer<typeof createAgentTokenSchema>,
  ): Promise<CreatedAgentToken> {
    return this.tokens.create(user.id, body.name);
  }

  @Delete('agent-tokens/:tokenId')
  @HttpCode(204)
  async revokeToken(
    @CurrentUser() user: AuthUser,
    @Param('tokenId') tokenId: string,
  ): Promise<void> {
    await this.tokens.revoke(user.id, tokenId);
  }
}
