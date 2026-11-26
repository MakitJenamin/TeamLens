import type { Schemas } from '@teamlens/schema';
import type { AuthUser } from '../../common/auth-context.js';
import { randomToken, sha256 } from '../../common/crypto.js';
import type { Database } from '../../db/client.js';
import { invites } from '../../db/schema/index.js';
import {
  DEFAULT_INVITE_DAYS,
  inviteLinks,
  inviteStatus,
} from './invite-status.js';

export type InviteDto = Schemas['Invite'];
export type CreatedInviteDto = Schemas['CreatedInvite'];

type InviteRow = typeof invites.$inferSelect;

export function toInviteDto(
  row: InviteRow,
  createdBy: { id: string; email: string | null; name: string } | null,
  now = new Date(),
): InviteDto {
  return {
    id: row.id,
    projectId: row.projectId,
    status: inviteStatus(row, now),
    expiresAt: row.expiresAt.toISOString(),
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdBy,
  };
}

/**
 * Tạo link mời (dùng chung cho `POST .../invites` và wizard setup). Chạy trong transaction
 * của nơi gọi; audit do nơi gọi ghi. Mã gốc chỉ trả về đúng lần này, DB lưu SHA-256.
 */
export async function insertInvite(
  db: Pick<Database, 'insert'>,
  publicUrl: string,
  input: {
    projectId: string;
    creator: AuthUser;
    expiresInDays?: number;
    maxUses?: number | null;
  },
): Promise<CreatedInviteDto> {
  const code = randomToken();
  const days = input.expiresInDays ?? DEFAULT_INVITE_DAYS;
  const [row] = await db
    .insert(invites)
    .values({
      projectId: input.projectId,
      codeHash: sha256(code),
      expiresAt: new Date(Date.now() + days * 86_400_000),
      maxUses: input.maxUses ?? null,
      createdBy: input.creator.id,
    })
    .returning();
  const { id, email, name } = input.creator;
  return {
    invite: toInviteDto(row, { id, email, name }),
    code,
    ...inviteLinks(publicUrl, code),
  };
}
