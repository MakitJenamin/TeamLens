import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { ApiError } from '../../common/api-error.js';
import { sha256 } from '../../common/crypto.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { agentTokens, users } from '../../db/schema/index.js';
import { AGENT_TOKEN_PREFIX } from '../ai-settings/agent-tokens.service.js';
import { toAuthUser } from '../auth/auth.service.js';
import { DeviceService } from '../device/device.service.js';
import type { McpCaller } from './mcp.types.js';

/** Chỉ ghi `last_used_at` khi đã cũ hơn mức này, tránh ghi DB mỗi request (giống device token). */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const DEVICE_TOKEN_PREFIX = 'tld_';

export const invalidToken = () =>
  new ApiError(401, 'invalid_token', 'Token không hợp lệ hoặc đã bị thu hồi.');

/**
 * Xác thực token của MCP: device token `tld_` (member qua `tl mcp`) hoặc token cá nhân `tlp_` (leader).
 * Quyền của token = quyền của user sở hữu nó. Không log token.
 */
@Injectable()
export class McpAuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly devices: DeviceService,
  ) {}

  /** `Authorization: Bearer <token>` → người gọi, hoặc 401 `invalid_token`. */
  async authenticate(authorization: string | undefined): Promise<McpCaller> {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!match) throw invalidToken();
    const token = match[1];

    if (token.startsWith(DEVICE_TOKEN_PREFIX)) {
      const result = await this.devices.authenticate(token);
      if (!result) throw invalidToken();
      return { user: result.user, tokenKind: 'device' };
    }
    if (token.startsWith(AGENT_TOKEN_PREFIX)) {
      return this.authenticateAgentToken(token);
    }
    throw invalidToken();
  }

  private async authenticateAgentToken(token: string): Promise<McpCaller> {
    const [row] = await this.db
      .select({ token: agentTokens, user: users })
      .from(agentTokens)
      .innerJoin(users, eq(users.id, agentTokens.userId))
      .where(
        and(
          eq(agentTokens.tokenHash, sha256(token)),
          isNull(agentTokens.revokedAt),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw invalidToken();

    const lastUsed = row.token.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - lastUsed > TOUCH_INTERVAL_MS) {
      await this.db
        .update(agentTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(agentTokens.id, row.token.id));
    }
    return { user: toAuthUser(row.user), tokenKind: 'agent' };
  }
}
