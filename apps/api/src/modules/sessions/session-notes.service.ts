import { Inject, Injectable } from '@nestjs/common';
import type { SessionNote, SessionNoteList } from '@teamlens/schema';
import { and, asc, eq } from 'drizzle-orm';
import { ApiError, forbidden, notFound } from '../../common/api-error.js';
import type { AuthUser } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { notes, sessions, turns, users } from '../../db/schema/index.js';
import { AccessService, isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';

export interface CreateNoteInput {
  turnSeq?: number | null;
  body: string;
}

const sessionNotFound = () => notFound('Không tìm thấy session');

interface NoteRow {
  id: string;
  sessionId: string;
  turnSeq: number | null;
  body: string;
  createdAt: Date;
  authorId: string | null;
  authorEmail: string | null;
  authorName: string | null;
}

function toNote(row: NoteRow): SessionNote {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnSeq: row.turnSeq,
    body: row.body,
    author:
      row.authorId && row.authorName !== null
        ? { id: row.authorId, email: row.authorEmail, name: row.authorName }
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Ghi chú của leader theo turn (M3.4, contract `sessions.yaml`).
 * Ai xem được session thì xem được ghi chú; chỉ leader tạo, chỉ tác giả xóa.
 */
@Injectable()
export class SessionNotesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /** Lấy chủ session và kiểm tra quyền xem; 404 khi không có, 403 khi không được xem. */
  private async assertCanView(viewer: AuthUser, sessionId: string) {
    if (!isUuid(sessionId)) throw sessionNotFound();
    const [session] = await this.db
      .select({ id: sessions.id, userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!session) throw sessionNotFound();
    if (!this.access.canViewUserData(viewer, session.userId)) throw forbidden();
    return session;
  }

  private selectNotes() {
    return this.db
      .select({
        id: notes.id,
        sessionId: notes.sessionId,
        turnSeq: notes.turnSeq,
        body: notes.body,
        createdAt: notes.createdAt,
        authorId: notes.authorId,
        authorEmail: users.email,
        authorName: users.name,
      })
      .from(notes)
      .leftJoin(users, eq(users.id, notes.authorId));
  }

  async list(viewer: AuthUser, sessionId: string): Promise<SessionNoteList> {
    await this.assertCanView(viewer, sessionId);
    const rows = await this.selectNotes()
      .where(eq(notes.sessionId, sessionId))
      .orderBy(asc(notes.createdAt), asc(notes.id));
    return { items: rows.map(toNote) };
  }

  async create(
    viewer: AuthUser,
    sessionId: string,
    input: CreateNoteInput,
  ): Promise<SessionNote> {
    this.access.assertLeader(viewer);
    await this.assertCanView(viewer, sessionId);
    const turnSeq = input.turnSeq ?? null;
    if (turnSeq !== null) {
      const [turn] = await this.db
        .select({ seq: turns.seq })
        .from(turns)
        .where(and(eq(turns.sessionId, sessionId), eq(turns.seq, turnSeq)))
        .limit(1);
      if (!turn)
        throw new ApiError(
          404,
          'turn_not_found',
          'Không tìm thấy turn trong session',
        );
    }

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(notes)
        .values({ sessionId, authorId: viewer.id, turnSeq, body: input.body })
        .returning({
          id: notes.id,
          sessionId: notes.sessionId,
          turnSeq: notes.turnSeq,
          body: notes.body,
          createdAt: notes.createdAt,
        });
      await this.audit.record(
        viewer.id,
        'session.note.create',
        'session',
        sessionId,
        tx,
      );
      return toNote({
        ...created,
        authorId: viewer.id,
        authorEmail: viewer.email,
        authorName: viewer.name,
      });
    });
  }

  async remove(
    viewer: AuthUser,
    sessionId: string,
    noteId: string,
  ): Promise<void> {
    this.access.assertLeader(viewer);
    await this.assertCanView(viewer, sessionId);
    if (!isUuid(noteId)) throw notFound('Không tìm thấy ghi chú');
    const [note] = await this.db
      .select({ id: notes.id, authorId: notes.authorId })
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.sessionId, sessionId)))
      .limit(1);
    if (!note) throw notFound('Không tìm thấy ghi chú');
    if (note.authorId !== viewer.id) throw forbidden();

    await this.db.transaction(async (tx) => {
      await tx.delete(notes).where(eq(notes.id, noteId));
      await this.audit.record(
        viewer.id,
        'session.note.delete',
        'session',
        sessionId,
        tx,
      );
    });
  }
}
