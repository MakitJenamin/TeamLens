import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  ApiError,
  isUniqueViolation,
  notFound,
} from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import { normalizeRemotePattern } from '../../common/remote-pattern.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  type ProjectRole,
  type ProjectSettings,
  projectMembers,
  projectRepos,
  projects,
  users,
} from '../../db/schema/index.js';
import { isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import { normalizeEmail } from '../auth/auth.service.js';

export interface RepoDto {
  id: string;
  remotePattern: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  settings: ProjectSettings;
}

export interface ProjectDetailDto extends ProjectDto {
  repos: RepoDto[];
}

export interface ProjectListItemDto {
  id: string;
  name: string;
  slug: string;
  role: ProjectRole | null;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: ProjectRole;
}

const memberNotFound = () =>
  notFound('Không tìm thấy thành viên trong project');

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Admin thấy mọi project (`role` = null nếu không là thành viên); người khác thấy project mình tham gia. */
  async list(user: AuthUser): Promise<ProjectListItemDto[]> {
    const role = projectMembers.role;
    const base = this.db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        role,
      })
      .from(projects);
    if (user.isAdmin) {
      return base
        .leftJoin(
          projectMembers,
          and(
            eq(projectMembers.projectId, projects.id),
            eq(projectMembers.userId, user.id),
          ),
        )
        .orderBy(asc(projects.name));
    }
    const rows = await base
      .innerJoin(
        projectMembers,
        and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, user.id),
        ),
      )
      .orderBy(asc(projects.name));
    return rows;
  }

  async create(
    actor: AuthUser,
    input: { name: string; slug: string },
  ): Promise<ProjectDto> {
    try {
      const [project] = await this.db
        .insert(projects)
        .values({ name: input.name, slug: input.slug })
        .returning();
      await this.audit.record(
        actor.id,
        'project.create',
        'project',
        project.id,
      );
      return this.toBase(project);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(
          409,
          'slug_taken',
          'Slug đã được dùng cho project khác',
        );
      }
      throw error;
    }
  }

  async get(projectId: string): Promise<ProjectDetailDto> {
    const project = await this.findProject(projectId);
    return { ...this.toBase(project), repos: await this.listRepos(projectId) };
  }

  async update(
    projectId: string,
    input: { name?: string; settings?: ProjectSettings },
  ): Promise<ProjectDto> {
    const project = await this.findProject(projectId);
    const patch: Partial<typeof projects.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    // `settings` được gộp nông với cấu hình hiện có.
    if (input.settings !== undefined)
      patch.settings = { ...project.settings, ...input.settings };
    if (Object.keys(patch).length === 0) return this.toBase(project);
    const [updated] = await this.db
      .update(projects)
      .set(patch)
      .where(eq(projects.id, projectId))
      .returning();
    return this.toBase(updated);
  }

  // ---- Thành viên ----

  async listMembers(projectId: string): Promise<MemberDto[]> {
    await this.findProject(projectId);
    return this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(
        and(eq(projectMembers.projectId, projectId), isNull(users.deletedAt)),
      )
      .orderBy(asc(users.email));
  }

  async addMember(
    actor: AuthUser,
    projectId: string,
    input: { email: string; role: ProjectRole },
  ): Promise<MemberDto> {
    await this.findProject(projectId);
    const [user] = await this.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.email, normalizeEmail(input.email)),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!user)
      throw new ApiError(
        404,
        'user_not_found',
        'Không tìm thấy người dùng với email này',
      );

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(projectMembers)
        .values({ projectId, userId: user.id, role: input.role })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) {
        throw new ApiError(
          409,
          'already_member',
          'Người dùng đã là thành viên của project',
        );
      }
      await this.audit.record(
        actor.id,
        'member.add',
        'project',
        `${projectId}:${user.id}`,
        tx,
      );
      return {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: input.role,
      };
    });
  }

  async updateMemberRole(
    actor: AuthUser,
    projectId: string,
    userId: string,
    role: ProjectRole,
  ): Promise<MemberDto> {
    if (!isUuid(userId)) throw memberNotFound();
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(projectMembers)
        .set({ role })
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, userId),
          ),
        )
        .returning();
      if (!updated) throw memberNotFound();
      await this.audit.record(
        actor.id,
        'member.role_change',
        'project',
        `${projectId}:${userId}`,
        tx,
      );
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      return { userId, email: user.email, name: user.name, role };
    });
  }

  async removeMember(
    actor: AuthUser,
    projectId: string,
    userId: string,
  ): Promise<void> {
    if (!isUuid(userId)) throw memberNotFound();
    await this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, userId),
          ),
        )
        .returning();
      if (deleted.length === 0) throw memberNotFound();
      await this.audit.record(
        actor.id,
        'member.remove',
        'project',
        `${projectId}:${userId}`,
        tx,
      );
    });
  }

  // ---- Repo pattern ----

  async listRepos(projectId: string): Promise<RepoDto[]> {
    return this.db
      .select({
        id: projectRepos.id,
        remotePattern: projectRepos.remotePattern,
      })
      .from(projectRepos)
      .where(eq(projectRepos.projectId, projectId))
      .orderBy(asc(projectRepos.remotePattern));
  }

  async addRepo(
    actor: AuthUser,
    projectId: string,
    rawPattern: string,
  ): Promise<RepoDto> {
    const remotePattern = normalizeRemotePattern(rawPattern);
    if (!remotePattern) {
      throw new ApiError(
        400,
        'invalid_pattern',
        'Pattern không hợp lệ, cần dạng host/org/repo hoặc host/org/*',
      );
    }
    await this.findProject(projectId);
    return this.db.transaction(async (tx) => {
      const [repo] = await tx
        .insert(projectRepos)
        .values({ projectId, remotePattern })
        .onConflictDoNothing()
        .returning({
          id: projectRepos.id,
          remotePattern: projectRepos.remotePattern,
        });
      if (!repo)
        throw new ApiError(
          409,
          'repo_exists',
          'Pattern này đã có trong project',
        );
      await this.audit.record(
        actor.id,
        'repo.add',
        'project',
        `${projectId}:${remotePattern}`,
        tx,
      );
      return repo;
    });
  }

  async removeRepo(
    actor: AuthUser,
    projectId: string,
    repoId: string,
  ): Promise<void> {
    if (!isUuid(repoId)) throw notFound('Không tìm thấy repo');
    await this.db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(projectRepos)
        .where(
          and(
            eq(projectRepos.id, repoId),
            eq(projectRepos.projectId, projectId),
          ),
        )
        .returning();
      if (!deleted) throw notFound('Không tìm thấy repo');
      await this.audit.record(
        actor.id,
        'repo.remove',
        'project',
        `${projectId}:${deleted.remotePattern}`,
        tx,
      );
    });
  }

  // ---- Nội bộ ----

  private async findProject(projectId: string) {
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    const [project] = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw notFound('Không tìm thấy project');
    return project;
  }

  private toBase(project: typeof projects.$inferSelect): ProjectDto {
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      settings: project.settings,
    };
  }
}
