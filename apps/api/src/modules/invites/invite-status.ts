import type { Schemas } from '@teamlens/schema';
import { ApiError } from '../../common/api-error.js';

export type InviteStatus = Schemas['InviteStatus'];

/** Hạn mặc định của link mời (ngày). */
export const DEFAULT_INVITE_DAYS = 7;

/** Mã mời hợp lệ về hình thức (base64url, 10–100 ký tự, theo contract). */
export const INVITE_CODE_RE = /^[A-Za-z0-9_-]{10,100}$/;

/**
 * Trạng thái link mời. Thứ tự ưu tiên: thu hồi > hết hạn > hết lượt > còn dùng được.
 */
export function inviteStatus(
  invite: {
    revokedAt: Date | null;
    expiresAt: Date;
    maxUses: number | null;
    usedCount: number;
  },
  now: Date = new Date(),
): InviteStatus {
  if (invite.revokedAt) return 'revoked';
  if (invite.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses)
    return 'used_up';
  return 'active';
}

/** Lỗi 410 tương ứng với trạng thái link không dùng được; `null` nếu còn dùng được. */
export function unusableInviteError(status: InviteStatus): ApiError | null {
  switch (status) {
    case 'revoked':
      return new ApiError(
        410,
        'invite_revoked',
        'Link mời đã bị thu hồi. Hãy xin leader link mới.',
      );
    case 'expired':
      return new ApiError(
        410,
        'invite_expired',
        'Link mời đã hết hạn. Hãy xin leader link mới.',
      );
    case 'used_up':
      return new ApiError(
        410,
        'invite_used_up',
        'Link mời đã hết lượt dùng. Hãy xin leader link mới.',
      );
    default:
      return null;
  }
}

export const inviteNotFound = () =>
  new ApiError(
    404,
    'invite_not_found',
    'Link mời không đúng. Hãy xin leader link mới.',
  );

/**
 * Lệnh PowerShell cài `tl` chung cho mọi link mời và mọi server (không kèm mã mời). Script cài
 * là asset `install.ps1` của GitHub Releases bản mới nhất, nguồn ở `deploy/install.ps1`: chỉ tải,
 * kiểm SHA-256 và cài `tl.exe`; tham gia nhóm là bước riêng `tl join <url>`.
 */
export const INSTALL_COMMAND =
  'irm https://github.com/MakitJenamin/TeamLens/releases/latest/download/install.ps1 | iex';

/** Link tham gia cho một mã mời, kèm lệnh cài `tl` chung (`installCommand` của contract). */
export function inviteLinks(
  publicUrl: string,
  code: string,
): { url: string; installCommand: string } {
  return {
    url: `${publicUrl}/i/${code}`,
    installCommand: INSTALL_COMMAND,
  };
}
