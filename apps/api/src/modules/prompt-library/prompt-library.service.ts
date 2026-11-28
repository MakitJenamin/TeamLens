import { Inject, Injectable } from '@nestjs/common';
import type {
  AddPromptLibraryItemRequest,
  PromptLibraryItem,
  PromptLibraryList,
} from '@teamlens/schema';
import { and, desc, eq, isNotNull, isNull, min } from 'drizzle-orm';
import {
  ApiError,
  forbidden,
  notFound,
} from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  projects,
  promptLibrary,
  sessions,
  turns,
  users,
} from '../../db/schema/index.js';
import { AccessService, isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';

/** Độ dài tối đa của prompt trả về trong thư viện. */
export const LIBRARY_PROMPT_MAX = 4000;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

const truncate = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

/** Thân request đã validate (`hideAuthor` có thể bỏ trống, mặc định false). */
export type AddPromptLibraryInput = Omit<AddPromptLibraryItemRequest, 'hideAuthor'> & {
  hideAuthor?: boolean;
};

const alreadyInLibrary = () =>
  new ApiError(409, 'already_in_library', 'Prompt này đã có trong thư viện.');

/**
 * Thư viện prompt mẫu của project (C2, M6.14): mục leader đã duyệt, thành viên của project xem được.
 *
 * Đây là chỗ duy nhất prompt của người này tới tay người khác, và chỉ sau khi leader duyệt từng mục. Mục `hideAuthor`
 * không lộ tên với thành viên, cũng không lộ `sessionId`/`turnSeq` (chỉ leader thấy để mở session gốc).
 * Nội dung prompt đọc từ `turns` mỗi lần (đã che secret ở máy thành viên), không sao chép sang bảng khác.
 */
@Injectable()
export class PromptLibraryService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** 404 nếu project không có, 403 nếu người xem không thuộc project. */
  async assertProjectAccess(
    viewer: AuthUser,
    projectId: string,
  ): Promise<void> {
    if (!isUuid(projectId)) throw notFound('Không tìm thấy project');
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw notFound('Không tìm thấy project');
    if (!(await this.access.canAccessProject(viewer, projectId)))
      throw forbidden();
  }

  async list(
    viewer: AuthUser,
    projectId: string,
    limit = DEFAULT_LIMIT,
  ): Promise<PromptLibraryList> {
    await this.assertProjectAccess(viewer, projectId);
    const leader = this.access.isLeader(viewer);
    const rows = await this.db
      .select({
        id: promptLibrary.id,
        note: promptLibrary.note,
        hideAuthor: promptLibrary.hideAuthor,
        sessionId: promptLibrary.sessionId,
        turnSeq: promptLibrary.turnSeq,
        createdAt: promptLibrary.createdAt,
        workType: sessions.workType,
        authorId: sessions.userId,
        authorName: users.name,
        text: turns.text,
      })
      .from(promptLibrary)
      .innerJoin(sessions, eq(sessions.id, promptLibrary.sessionId))
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(
        turns,
        and(
          eq(turns.sessionId, promptLibrary.sessionId),
          eq(turns.seq, promptLibrary.turnSeq),
          eq(turns.role, 'user'),
          eq(turns.kind, 'prompt'),
        ),
      )
      .where(eq(promptLibrary.projectId, projectId))
      .orderBy(desc(promptLibrary.createdAt), desc(promptLibrary.id))
      .limit(Math.min(Math.max(limit, 1), MAX_LIMIT));

    return {
      items: rows.map((r) =>
        this.toItem(
          {
            id: r.id,
            prompt: r.text ?? '',
            note: r.note,
            workType: r.workType,
            hideAuthor: r.hideAuthor,
            author: { userId: r.authorId, name: r.authorName },
            sessionId: r.sessionId,
            turnSeq: r.turnSeq,
            createdAt: r.createdAt,
          },
          leader,
        ),
      ),
    };
  }

  /** Leader duyệt một prompt vào thư viện. */
  async add(
    viewer: AuthUser,
    projectId: string,
    input: AddPromptLibraryInput,
  ): Promise<PromptLibraryItem> {
    this.access.assertLeader(viewer);
    await this.assertProjectAccess(viewer, projectId);

    const [session] = await this.db
      .select({
        id: sessions.id,
        workType: sessions.workType,
        authorId: sessions.userId,
        authorName: users.name,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, input.sessionId),
          eq(sessions.projectId, projectId),
          // Prompt trong session con do agent viết, không phải người dùng (SPEC 9.1).
          isNull(sessions.parentSourceId),
          isNull(sessions.parentSessionId),
        ),
      );
    if (!session) throw notFound('Không tìm thấy session trong project này');

    let turnSeq = input.turnSeq;
    if (turnSeq === undefined) {
      const [first] = await this.db
        .select({ seq: min(turns.seq) })
        .from(turns)
        .where(
          and(
            eq(turns.sessionId, session.id),
            eq(turns.role, 'user'),
            eq(turns.kind, 'prompt'),
            isNotNull(turns.text),
          ),
        );
      turnSeq = first?.seq ?? undefined;
    }
    const [turn] =
      turnSeq === undefined
        ? []
        : await this.db
            .select({ text: turns.text })
            .from(turns)
            .where(
              and(
                eq(turns.sessionId, session.id),
                eq(turns.seq, turnSeq),
                eq(turns.role, 'user'),
                eq(turns.kind, 'prompt'),
                isNotNull(turns.text),
              ),
            );
    if (turnSeq === undefined || !turn?.text)
      throw new ApiError(
        400,
        'invalid_turn',
        'Lượt này không phải prompt của người dùng trong session.',
      );

    const [existing] = await this.db
      .select({ id: promptLibrary.id })
      .from(promptLibrary)
      .where(
        and(
          eq(promptLibrary.projectId, projectId),
          eq(promptLibrary.sessionId, session.id),
          eq(promptLibrary.turnSeq, turnSeq),
        ),
      );
    if (existing) throw alreadyInLibrary();

    const hideAuthor = input.hideAuthor ?? false;
    const note = input.note?.trim() ? input.note.trim() : null;
    const [row] = await this.db
      .insert(promptLibrary)
      .values({
        projectId,
        sessionId: session.id,
        turnSeq,
        note,
        hideAuthor,
        approvedBy: viewer.id,
      })
      .returning();
    await this.audit.record(
      viewer.id,
      'prompt_library.add',
      'project',
      projectId,
      this.db,
      { itemId: row.id, sessionId: session.id, turnSeq, hideAuthor },
    );
    return this.toItem(
      {
        id: row.id,
        prompt: turn.text,
        note: row.note,
        workType: session.workType,
        hideAuthor: row.hideAuthor,
        author: { userId: session.authorId, name: session.authorName },
        sessionId: session.id,
        turnSeq,
        createdAt: row.createdAt,
      },
      true,
    );
  }

  async remove(
    viewer: AuthUser,
    projectId: string,
    itemId: string,
  ): Promise<void> {
    this.access.assertLeader(viewer);
    await this.assertProjectAccess(viewer, projectId);
    if (!isUuid(itemId)) throw notFound('Không tìm thấy mục trong thư viện');
    const [row] = await this.db
      .delete(promptLibrary)
      .where(
        and(
          eq(promptLibrary.id, itemId),
          eq(promptLibrary.projectId, projectId),
        ),
      )
      .returning({
        id: promptLibrary.id,
        sessionId: promptLibrary.sessionId,
        turnSeq: promptLibrary.turnSeq,
      });
    if (!row) throw notFound('Không tìm thấy mục trong thư viện');
    await this.audit.record(
      viewer.id,
      'prompt_library.remove',
      'project',
      projectId,
      this.db,
      { itemId, sessionId: row.sessionId, turnSeq: row.turnSeq },
    );
  }

  /** Che theo người xem: thành viên không thấy tên khi `hideAuthor`, và không bao giờ thấy `sessionId`/`turnSeq`. */
  private toItem(
    item: {
      id: string;
      prompt: string;
      note: string | null;
      workType: PromptLibraryItem['workType'];
      hideAuthor: boolean;
      author: { userId: string; name: string };
      sessionId: string;
      turnSeq: number | null;
      createdAt: Date;
    },
    leader: boolean,
  ): PromptLibraryItem {
    return {
      id: item.id,
      prompt: truncate(item.prompt, LIBRARY_PROMPT_MAX),
      note: item.note,
      workType: item.workType,
      author: leader || !item.hideAuthor ? item.author : null,
      hideAuthor: item.hideAuthor,
      sessionId: leader ? item.sessionId : null,
      turnSeq: leader ? item.turnSeq : null,
      createdAt: item.createdAt.toISOString(),
    };
  }
}
