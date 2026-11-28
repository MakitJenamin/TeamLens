import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { type AuthUser, CurrentUser } from '../../common/auth-context.js';
import { LeaderOnly } from '../access/access.guards.js';
import { SkillCatalogService } from './skill-catalog.service.js';

export const createSourceBodySchema = z.strictObject({
  url: z.string().min(1).max(300),
});

export const updateSourceBodySchema = z.strictObject({
  enabled: z.boolean(),
});

/** Nguồn catalog skill cộng đồng (M6.13; contract `skills.yaml`). Mọi người xem được, chỉ leader sửa. */
@Controller('api/v1/skill-catalog-sources')
export class SkillCatalogController {
  constructor(
    @Inject(SkillCatalogService) private readonly catalog: SkillCatalogService,
  ) {}

  @Get()
  list() {
    return this.catalog.list();
  }

  @Post()
  @LeaderOnly()
  create(
    @CurrentUser() user: AuthUser,
    @Body({ schema: createSourceBodySchema })
    body: z.infer<typeof createSourceBodySchema>,
  ) {
    return this.catalog.create(user.id, body.url);
  }

  @Patch(':sourceId')
  @LeaderOnly()
  update(
    @CurrentUser() user: AuthUser,
    @Param('sourceId') sourceId: string,
    @Body({ schema: updateSourceBodySchema })
    body: z.infer<typeof updateSourceBodySchema>,
  ) {
    return this.catalog.setEnabled(user.id, sourceId, body.enabled);
  }

  @Delete(':sourceId')
  @LeaderOnly()
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('sourceId') sourceId: string,
  ): Promise<void> {
    await this.catalog.remove(user.id, sourceId);
  }
}
