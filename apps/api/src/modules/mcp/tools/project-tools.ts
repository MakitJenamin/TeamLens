import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { forbidden, notFound } from '../../../common/api-error.js';
import { AccessService, isUuid } from '../../access/access.service.js';
import { ProjectsService } from '../../projects/projects.service.js';
import { OverviewService } from '../../stats/overview.service.js';
import { ProfileService } from '../../stats/profile.service.js';
import { McpToolRegistry } from '../mcp-tool-registry.js';
import type { McpCaller } from '../mcp.types.js';
import { BaseMcpTool, isoDateTime, parseArgs, uuidArg } from './base-tool.js';

/** `list_projects`: project người gọi xem được (cùng quy tắc với `GET /api/v1/projects`). */
@Injectable()
export class ListProjectsTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly projects: ProjectsService,
  ) {
    super('list_projects', registry);
  }

  async run(caller: McpCaller): Promise<Record<string, unknown>> {
    const list = await this.projects.list(caller.user);
    return {
      projects: list.map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
    };
  }
}

const listMembersArgs = z.strictObject({ projectId: uuidArg('projectId') });

/**
 * `list_members`: thành viên của project, không có email. Member chỉ thấy chính mình (như trang
 * thành viên của dashboard không dành cho member); leader thấy cả project. Chỉ metadata, không ghi audit.
 */
@Injectable()
export class ListMembersTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly projects: ProjectsService,
    private readonly access: AccessService,
  ) {
    super('list_members', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { projectId } = parseArgs(listMembersArgs, args);
    if (!(await this.access.canAccessProject(caller.user, projectId))) {
      throw forbidden();
    }
    const members = await this.projects.listMembers(projectId);
    const visible = this.access.isLeader(caller.user)
      ? members
      : members.filter((m) => m.userId === caller.user.id);
    return {
      members: visible.map((m) => ({
        userId: m.userId,
        name: m.name,
        role: m.role,
      })),
    };
  }
}

const overviewArgs = z.strictObject({
  projectId: uuidArg('projectId'),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

/** `get_overview`: tổng quan project theo tuần. Chỉ leader, giống `GET /api/v1/projects/:id/overview`. */
@Injectable()
export class GetOverviewTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly overview: OverviewService,
    private readonly access: AccessService,
  ) {
    super('get_overview', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { projectId, from, to } = parseArgs(overviewArgs, args);
    this.access.assertLeader(caller.user);
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    const overview = await this.overview.get(projectId, { from, to });
    return overview as unknown as Record<string, unknown>;
  }
}

const profileArgs = z.strictObject({
  userId: uuidArg('userId'),
  projectId: uuidArg('projectId'),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

/**
 * `get_member_profile`: hồ sơ một thành viên. Quyền và audit (`profile.view`) do `ProfileService` lo,
 * giống hệt `GET /api/v1/users/:id/profile`.
 */
@Injectable()
export class GetMemberProfileTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly profile: ProfileService,
  ) {
    super('get_member_profile', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { userId, projectId, from, to } = parseArgs(profileArgs, args);
    const profile = await this.profile.get(caller.user, userId, {
      project: projectId,
      from,
      to,
    });
    return profile as unknown as Record<string, unknown>;
  }
}
