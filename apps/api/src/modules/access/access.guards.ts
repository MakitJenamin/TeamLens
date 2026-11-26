import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import {
  forbidden,
  notFound,
  unauthenticated,
} from '../../common/api-error.js';
import type { AuthRequest } from '../../common/auth-context.js';
import { AccessService, isUuid } from './access.service.js';

/** Chỉ leader (vai trò toàn server) được đi qua. */
@Injectable()
export class LeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<AuthRequest>().user;
    if (!user) throw unauthenticated();
    if (user.role !== 'leader') throw forbidden();
    return true;
  }
}

/** Leader, hoặc member thuộc project lấy từ `:projectId`. */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(private readonly access: AccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (!req.user) throw unauthenticated();
    const projectId = req.params.projectId;
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    if (!(await this.access.canAccessProject(req.user, projectId)))
      throw forbidden();
    return true;
  }
}

/** Route chỉ dành cho leader (SPEC 11.1). */
export const LeaderOnly = () => applyDecorators(UseGuards(LeaderGuard));

/** Route theo project: leader, hoặc thành viên của `:projectId`. */
export const ProjectAccess = () =>
  applyDecorators(UseGuards(ProjectAccessGuard));
