import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { type AuthUser, CurrentUser } from '../../common/auth-context.js';
import { LeaderOnly, ProjectAccess } from '../access/access.guards.js';
import { ProjectsService } from './projects.service.js';

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Tên project không được để trống').max(100),
  slug: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
      'Slug chỉ gồm chữ thường, số và dấu gạch ngang (tối đa 64 ký tự)',
    ),
});

const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

const addMemberSchema = z.object({ userId: z.uuid('userId phải là UUID') });

const addRepoSchema = z.object({ remotePattern: z.string().max(300) });

@Controller('api/v1/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.projects.list(user);
  }

  @Post()
  @LeaderOnly()
  create(
    @CurrentUser() user: AuthUser,
    @Body({ schema: createProjectSchema })
    body: z.infer<typeof createProjectSchema>,
  ) {
    return this.projects.create(user, body);
  }

  @Get(':projectId')
  @ProjectAccess()
  get(@Param('projectId') projectId: string) {
    return this.projects.get(projectId);
  }

  @Patch(':projectId')
  @LeaderOnly()
  update(
    @Param('projectId') projectId: string,
    @Body({ schema: updateProjectSchema })
    body: z.infer<typeof updateProjectSchema>,
  ) {
    return this.projects.update(projectId, body);
  }

  @Get(':projectId/members')
  @LeaderOnly()
  listMembers(@Param('projectId') projectId: string) {
    return this.projects.listMembers(projectId);
  }

  @Post(':projectId/members')
  @LeaderOnly()
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body({ schema: addMemberSchema }) body: z.infer<typeof addMemberSchema>,
  ) {
    return this.projects.addMember(user, projectId, body.userId);
  }

  @Delete(':projectId/members/:userId')
  @LeaderOnly()
  @HttpCode(204)
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.projects.removeMember(user, projectId, userId);
  }

  @Get(':projectId/repos')
  @ProjectAccess()
  listRepos(@Param('projectId') projectId: string) {
    return this.projects.listRepos(projectId);
  }

  @Post(':projectId/repos')
  @LeaderOnly()
  addRepo(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body({ schema: addRepoSchema }) body: z.infer<typeof addRepoSchema>,
  ) {
    return this.projects.addRepo(user, projectId, body.remotePattern);
  }

  @Delete(':projectId/repos/:repoId')
  @LeaderOnly()
  @HttpCode(204)
  async removeRepo(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('repoId') repoId: string,
  ): Promise<void> {
    await this.projects.removeRepo(user, projectId, repoId);
  }
}
