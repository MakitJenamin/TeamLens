import { normalizeRemotePattern } from '../../common/remote-pattern.js';

/** Một repo pattern của project mà user là thành viên. */
export interface MemberRepoPattern {
  projectId: string;
  remotePattern: string;
}

/**
 * Chuẩn hóa `repo_remote` CLI gửi lên (CLI đã chuẩn hóa, server làm lại cho chắc):
 * chữ thường, bỏ scheme/`git@`/`.git`/`/` cuối. Dạng khác `host/org/repo`
 * (vd. subgroup GitLab) thì chỉ hạ chữ thường, bỏ `/` và `.git` ở cuối.
 */
export function normalizeRepoRemote(remote: string): string {
  const normalized = normalizeRemotePattern(remote);
  if (normalized && !normalized.endsWith('/*')) return normalized;
  return remote
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

/**
 * Tìm project cho một remote đã chuẩn hóa. Pattern cụ thể nhất thắng: khớp đúng
 * `host/org/repo` hơn `host/org/*`. Hai pattern cùng mức thì lấy pattern đứng trước
 * trong danh sách (caller sắp xếp ổn định theo thời điểm thêm repo).
 *
 * `*` thay cho đúng một đoạn cuối (không khớp subgroup `host/org/sub/repo`).
 */
export function matchProject(
  remote: string,
  patterns: readonly MemberRepoPattern[],
): string | null {
  let wildcard: string | null = null;
  for (const p of patterns) {
    if (p.remotePattern === remote) return p.projectId;
    if (wildcard === null && p.remotePattern.endsWith('/*')) {
      const prefix = p.remotePattern.slice(0, -1);
      const rest = remote.slice(prefix.length);
      if (remote.startsWith(prefix) && rest.length > 0 && !rest.includes('/')) {
        wildcard = p.projectId;
      }
    }
  }
  return wildcard;
}
