import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, isNull, or } from 'drizzle-orm';
import { notFound } from '../../common/api-error.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { rules, type RuleSeverity } from '../../db/schema/index.js';
import { isUuid } from '../access/access.service.js';

export interface RuleSummary {
  key: string;
  category: string;
  severity: RuleSeverity;
  enabled: boolean;
  version: number;
  /** `default`: rule mặc định toàn server; `project`: rule riêng của project (ghi đè rule mặc định cùng khóa). */
  scope: 'default' | 'project';
}

export interface RuleDetail extends RuleSummary {
  definition: Record<string, unknown>;
  updatedAt: string;
}

type RuleRow = typeof rules.$inferSelect;

function toDetail(row: RuleRow): RuleDetail {
  return {
    key: row.key,
    category: row.category,
    severity: row.severity,
    enabled: row.enabled,
    version: row.version,
    scope: row.projectId ? 'project' : 'default',
    definition: (row.definition ?? {}) as Record<string, unknown>,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSummary(row: RuleRow): RuleSummary {
  const { definition: _definition, updatedAt: _updatedAt, ...summary } = toDetail(row);
  return summary;
}

/**
 * Đọc rule (chỉ đọc; M6.15 cho tool MCP `list_rules`, `get_rule`). Quản lý rule trên web (M4.4) mở rộng
 * hoặc thay thế dịch vụ này. Quy tắc áp dụng giống `score-session.ts`: rule riêng của project ghi đè rule
 * mặc định cùng khóa. Nơi gọi tự kiểm quyền vào project trước khi truyền `projectId`.
 */
@Injectable()
export class RulesQueryService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Rule hiệu lực, theo khóa. Không có `projectId` thì chỉ rule mặc định. */
  async list(projectId?: string): Promise<RuleSummary[]> {
    return (await this.effective(projectId)).map(toSummary);
  }

  /** Một rule hiệu lực theo khóa; 404 khi không có. */
  async get(key: string, projectId?: string): Promise<RuleDetail> {
    const row = (await this.effective(projectId)).find((r) => r.key === key);
    if (!row) throw notFound('Không tìm thấy rule');
    return toDetail(row);
  }

  private async effective(projectId?: string): Promise<RuleRow[]> {
    if (projectId !== undefined && !isUuid(projectId)) {
      throw notFound('Không tìm thấy project');
    }
    const rows = await this.db
      .select()
      .from(rules)
      .where(
        projectId === undefined
          ? isNull(rules.projectId)
          : or(isNull(rules.projectId), eq(rules.projectId, projectId)),
      )
      .orderBy(asc(rules.key));
    const byKey = new Map<string, RuleRow>();
    for (const row of rows) if (!row.projectId) byKey.set(row.key, row);
    for (const row of rows) if (row.projectId) byKey.set(row.key, row);
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
}
