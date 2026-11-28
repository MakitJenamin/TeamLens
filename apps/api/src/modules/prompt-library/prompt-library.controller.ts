import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { type AuthUser, CurrentUser } from '../../common/auth-context.js';
import { LeaderOnly, ProjectAccess } from '../access/access.guards.js';
import { isoDateTime, localeSchema } from '../skills/skills.schemas.js';
import { PromptCandidatesService } from './prompt-candidates.service.js';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PromptLibraryService,
} from './prompt-library.service.js';

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export const addItemBodySchema = z.strictObject({
  sessionId: z.uuid('sessionId phải là UUID'),
  turnSeq: z.number().int().min(0).optional(),
  note: z.string().max(1000).optional(),
  hideAuthor: z.boolean().optional(),
});

export const candidatesQuerySchema = z.object({
  locale: localeSchema.default('vi'),
});

export const runCandidatesBodySchema = z.strictObject({
  locale: localeSchema,
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

/** Thư viện prompt mẫu (M6.14; contract `prompt-library.yaml`): thành viên xem, leader duyệt và gỡ. */
@Controller('api/v1/projects/:projectId/prompt-library')
@ProjectAccess()
export class PromptLibraryController {
  constructor(
    @Inject(PromptLibraryService) private readonly library: PromptLibraryService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Query({ schema: listQuerySchema }) query: z.infer<typeof listQuerySchema>,
  ) {
    return this.library.list(user, projectId, query.limit);
  }

  @Post()
  @LeaderOnly()
  add(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body({ schema: addItemBodySchema })
    body: z.infer<typeof addItemBodySchema>,
  ) {
    return this.library.add(user, projectId, body);
  }

  @Delete(':itemId')
  @LeaderOnly()
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
  ): Promise<void> {
    await this.library.remove(user, projectId, itemId);
  }
}

/** C2 bước 1 (M6.14): leader tìm prompt mẫu, AI viết tiêu đề và lý do. */
@Controller('api/v1/projects/:projectId/ai/prompt-candidates')
@ProjectAccess()
@LeaderOnly()
export class PromptCandidatesController {
  constructor(
    @Inject(PromptCandidatesService)
    private readonly candidates: PromptCandidatesService,
  ) {}

  @Get()
  saved(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Query({ schema: candidatesQuerySchema })
    query: z.infer<typeof candidatesQuerySchema>,
  ) {
    return this.candidates.saved(user, projectId, query.locale);
  }

  @Post()
  @HttpCode(200)
  run(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body({ schema: runCandidatesBodySchema })
    body: z.infer<typeof runCandidatesBodySchema>,
  ) {
    const { locale, ...range } = body;
    return this.candidates.run(user, projectId, range, locale);
  }
}
