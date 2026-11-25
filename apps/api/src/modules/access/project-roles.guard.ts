import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  forbidden,
  notFound,
  unauthenticated,
} from '../../common/api-error.js';
import type { AuthRequest } from '../../common/auth-context.js';
import type { ProjectRole } from '../../db/schema/index.js';
import { AccessService, isUuid } from './access.service.js';

const PROJECT_ROLES_KEY = 'teamlens:projectRoles';

@Injectable()
export class ProjectRolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles =
      this.reflector.getAllAndOverride<ProjectRole[]>(PROJECT_ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (!req.user) throw unauthenticated();
    const projectId = req.params.projectId;
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    if (!(await this.access.hasProjectRole(req.user, projectId, roles)))
      throw forbidden();
    return true;
  }
}

/**
 * Yêu cầu user có một trong các vai trò trong project lấy từ `:projectId` (admin luôn qua).
 * Ví dụ: `@ProjectRoles('leader')`, `@ProjectRoles('leader', 'member')`.
 */
export const ProjectRoles = (...roles: ProjectRole[]) =>
  applyDecorators(
    SetMetadata(PROJECT_ROLES_KEY, roles),
    UseGuards(ProjectRolesGuard),
  );
