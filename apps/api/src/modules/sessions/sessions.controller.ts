import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { type AuthUser, CurrentUser } from '../../common/auth-context.js';
import { ProjectAccess } from '../access/access.guards.js';
import { AGENT_KINDS, WORK_TYPES } from './session-mappers.js';
import { SessionNotesService } from './session-notes.service.js';
import { SessionsService } from './sessions.service.js';

const isoDateTime = z.iso
  .datetime({ offset: true, message: 'Phải là thời điểm ISO 8601' })
  .transform((value) => new Date(value));

export const listSessionsQuerySchema = z.object({
  userId: z.uuid('userId phải là UUID').optional(),
  agent: z.enum(AGENT_KINDS, 'agent không hợp lệ').optional(),
  workType: z.enum(WORK_TYPES, 'workType không hợp lệ').optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  includeSubagents: z
    .enum(['true', 'false'], 'includeSubagents phải là true hoặc false')
    .optional()
    .transform((value) => value === 'true'),
  // Từ khóa tìm kiếm full-text (M4.1). Là nội dung prompt: không log.
  q: z
    .string()
    .trim()
    .min(1, 'q không được để trống')
    .max(200, 'q tối đa 200 ký tự')
    .optional(),
  limit: z.coerce
    .number()
    .int('limit phải là số nguyên')
    .min(1)
    .max(100)
    .default(50),
  cursor: z.string().min(1).max(500).optional(),
});

export const createNoteSchema = z.object({
  turnSeq: z.number().int('turnSeq phải là số nguyên').min(0).nullish(),
  body: z
    .string()
    .trim()
    .min(1, 'Ghi chú không được để trống')
    .max(4000, 'Ghi chú tối đa 4000 ký tự'),
});

/** Xem session trên dashboard: danh sách theo project và chi tiết (contract `sessions.yaml`). */
@Controller('api/v1')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly notes: SessionNotesService,
  ) {}

  @Get('projects/:projectId/sessions')
  @ProjectAccess()
  list(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Query({ schema: listSessionsQuerySchema })
    query: z.infer<typeof listSessionsQuerySchema>,
  ) {
    return this.sessions.list(user, projectId, query);
  }

  @Get('sessions/:sessionId')
  get(@CurrentUser() user: AuthUser, @Param('sessionId') sessionId: string) {
    return this.sessions.get(user, sessionId);
  }

  @Get('sessions/:sessionId/notes')
  listNotes(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.notes.list(user, sessionId);
  }

  @Post('sessions/:sessionId/notes')
  createNote(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
    @Body({ schema: createNoteSchema }) body: z.infer<typeof createNoteSchema>,
  ) {
    return this.notes.create(user, sessionId, body);
  }

  @Delete('sessions/:sessionId/notes/:noteId')
  @HttpCode(204)
  async deleteNote(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
    @Param('noteId') noteId: string,
  ): Promise<void> {
    await this.notes.remove(user, sessionId, noteId);
  }
}
