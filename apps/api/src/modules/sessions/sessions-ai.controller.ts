import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { type AuthUser, CurrentUser } from '../../common/auth-context.js';
import { SessionsAiService } from './sessions-ai.service.js';

const localeSchema = z.enum(['vi', 'en'], 'locale phải là vi hoặc en');

export const aiResultsQuerySchema = z.object({
  locale: localeSchema.default('vi'),
});

export const runAiBodySchema = z.strictObject({ locale: localeSchema });

/** Nút AI trên trang session (contract `ai.yaml`): A1, A5, A4 và đọc lại kết quả của người gọi. */
@Controller('api/v1')
export class SessionsAiController {
  constructor(private readonly ai: SessionsAiService) {}

  @Get('sessions/:sessionId/ai')
  results(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
    @Query({ schema: aiResultsQuerySchema })
    query: z.infer<typeof aiResultsQuerySchema>,
  ) {
    return this.ai.results(user, sessionId, query.locale);
  }

  @Post('sessions/:sessionId/ai/summary')
  @HttpCode(200)
  summary(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
    @Body({ schema: runAiBodySchema }) body: z.infer<typeof runAiBodySchema>,
  ) {
    return this.ai.summarize(user, sessionId, body.locale);
  }

  @Post('sessions/:sessionId/ai/outcome')
  @HttpCode(200)
  outcome(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
    @Body({ schema: runAiBodySchema }) body: z.infer<typeof runAiBodySchema>,
  ) {
    return this.ai.outcome(user, sessionId, body.locale);
  }

  @Post('findings/:findingId/ai/explain')
  @HttpCode(200)
  explain(
    @CurrentUser() user: AuthUser,
    @Param('findingId') findingId: string,
    @Body({ schema: runAiBodySchema }) body: z.infer<typeof runAiBodySchema>,
  ) {
    return this.ai.explainFinding(user, findingId, body.locale);
  }
}
