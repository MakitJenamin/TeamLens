import { Inject, Injectable } from '@nestjs/common';
import type { AgentToken, CreatedAgentToken } from '@teamlens/schema';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { notFound } from '../../common/api-error.js';
import { randomToken, sha256 } from '../../common/crypto.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { agentTokens } from '../../db/schema/index.js';
import { isUuid } from '../access/access.service.js';

/** Tiền tố token cá nhân cho MCP (AGENTS.md mục 4); device token của CLI là `tld_`. */
export const AGENT_TOKEN_PREFIX = 'tlp_';

type AgentTokenRow = typeof agentTokens.$inferSelect;

function toAgentToken(row: AgentTokenRow): AgentToken {
  return {
    id: row.id,
    name: row.name,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Token cá nhân `tlp_` để agent gọi MCP (bảng `agent_tokens`). Mọi thao tác chỉ trên token của chính userId.
 * DB chỉ lưu SHA-256; token nguyên văn trả đúng một lần lúc tạo. Không log token.
 */
@Injectable()
export class AgentTokensService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Token chưa thu hồi của userId, mới nhất trước. */
  async listOwn(userId: string): Promise<AgentToken[]> {
    const rows = await this.db
      .select()
      .from(agentTokens)
      .where(and(eq(agentTokens.userId, userId), isNull(agentTokens.revokedAt)))
      .orderBy(desc(agentTokens.createdAt), desc(agentTokens.id));
    return rows.map(toAgentToken);
  }

  /** Tạo token `tlp_` + 32 byte ngẫu nhiên (giống device token `tld_`). */
  async create(userId: string, name: string): Promise<CreatedAgentToken> {
    const secret = AGENT_TOKEN_PREFIX + randomToken();
    const [row] = await this.db
      .insert(agentTokens)
      .values({ userId, name, tokenHash: sha256(secret) })
      .returning();
    return { token: toAgentToken(row), secret };
  }

  /** Thu hồi token của chính userId. Không tồn tại, của người khác hoặc đã thu hồi → 404. */
  async revoke(userId: string, tokenId: string): Promise<void> {
    const missing = () => notFound('Không tìm thấy token');
    if (!isUuid(tokenId)) throw missing();
    const revoked = await this.db
      .update(agentTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(agentTokens.id, tokenId),
          eq(agentTokens.userId, userId),
          isNull(agentTokens.revokedAt),
        ),
      )
      .returning({ id: agentTokens.id });
    if (revoked.length === 0) throw missing();
  }
}
