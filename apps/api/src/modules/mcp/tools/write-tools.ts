import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AccessService } from '../../access/access.service.js';
import { RulesWriteService } from '../../rules/rules-write.service.js';
import { SessionNotesService } from '../../sessions/session-notes.service.js';
import { McpToolRegistry } from '../mcp-tool-registry.js';
import type { McpCaller } from '../mcp.types.js';
import { BaseMcpTool, parseArgs, uuidArg } from './base-tool.js';

/** Thao tác ghi qua MCP được ghi nhận nguồn này trong `audit_log.details`. */
const VIA = 'mcp';

const ruleKey = z.string().min(1).max(100);
const overrideFields = {
  severity: z.enum(['low', 'medium', 'high']).optional(),
  thresholds: z
    .record(z.string().min(1).max(50), z.number().min(0))
    .refine((o) => Object.keys(o).length >= 1, 'thresholds không được rỗng')
    .optional(),
  message: z.string().trim().min(1).max(500).optional(),
  advice: z.string().trim().min(1).max(1000).optional(),
};
const draftArgs = z.strictObject({
  key: ruleKey,
  projectId: uuidArg('projectId'),
  ...overrideFields,
});

function splitOverride(args: z.infer<typeof draftArgs>) {
  const { key, projectId, ...override } = args;
  return { key, projectId, override };
}

/** `draft_rule`: soạn thử thay đổi cho rule, không lưu gì. Chỉ leader (kiểm ở dịch vụ). */
@Injectable()
export class DraftRuleTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly rules: RulesWriteService,
  ) {
    super('draft_rule', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { key, projectId, override } = splitOverride(
      parseArgs(draftArgs, args),
    );
    const result = await this.rules.draft(
      caller.user,
      projectId,
      key,
      override,
    );
    return result as unknown as Record<string, unknown>;
  }
}

/** `test_rule`: chạy thử trên 50 session gần nhất, không trả nội dung turn. Chỉ leader. */
@Injectable()
export class TestRuleTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly rules: RulesWriteService,
  ) {
    super('test_rule', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { key, projectId, override } = splitOverride(
      parseArgs(draftArgs, args),
    );
    const result = await this.rules.testOnSessions(
      caller.user,
      projectId,
      key,
      override,
    );
    return result as unknown as Record<string, unknown>;
  }
}

/** `save_rule`: lưu bản riêng của project, audit giá trị cũ và mới, phát job chấm lại. Chỉ leader. */
@Injectable()
export class SaveRuleTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly rules: RulesWriteService,
  ) {
    super('save_rule', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { key, projectId, override } = splitOverride(
      parseArgs(draftArgs, args),
    );
    const { rule, changes, rescore } = await this.rules.save(
      caller.user,
      projectId,
      key,
      override,
      VIA,
    );
    return { rule, changes, rescore };
  }
}

const enabledArgs = z.strictObject({
  key: ruleKey,
  projectId: uuidArg('projectId'),
  enabled: z.boolean(),
});

/** `set_rule_enabled`: bật/tắt rule cho một project, audit giá trị cũ và mới, phát job chấm lại. Chỉ leader. */
@Injectable()
export class SetRuleEnabledTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly rules: RulesWriteService,
  ) {
    super('set_rule_enabled', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { key, projectId, enabled } = parseArgs(enabledArgs, args);
    const { rule, previousEnabled, rescore } = await this.rules.setEnabled(
      caller.user,
      projectId,
      key,
      enabled,
      VIA,
    );
    // Contract của tool này chỉ trả phần tóm tắt, không có định nghĩa.
    const { definition: _definition, updatedAt: _updatedAt, ...summary } = rule;
    return { rule: summary, previousEnabled, rescore };
  }
}

const noteArgs = z.strictObject({
  sessionId: uuidArg('sessionId'),
  turnSeq: z.number().int().min(0).nullish(),
  body: z.string().trim().min(1).max(4000),
});

/** `add_session_note`: ghi chú của leader. Quyền và audit `session.note.create` do `SessionNotesService` lo. */
@Injectable()
export class AddSessionNoteTool extends BaseMcpTool {
  constructor(
    registry: McpToolRegistry,
    private readonly notes: SessionNotesService,
    private readonly access: AccessService,
  ) {
    super('add_session_note', registry);
  }

  async run(caller: McpCaller, args: unknown): Promise<Record<string, unknown>> {
    const { sessionId, turnSeq, body } = parseArgs(noteArgs, args);
    this.access.assertLeader(caller.user);
    const note = await this.notes.create(caller.user, sessionId, {
      turnSeq,
      body,
    });
    return { note };
  }
}
