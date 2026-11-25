const HOST_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const SEGMENT_RE = /^[a-z0-9._-]+$/;

function isValidSegment(segment: string): boolean {
  return SEGMENT_RE.test(segment) && segment !== '.' && segment !== '..';
}

/**
 * Chuẩn hóa pattern remote git của project.
 *
 * Quy tắc (theo contract): chữ thường, bỏ `https://`, `ssh://`, `git@`, đổi `host:org`
 * thành `host/org`, bỏ `.git` và `/` ở cuối. Dạng hợp lệ: `host/org/repo` hoặc `host/org/*`.
 *
 * Trả về `null` nếu không hợp lệ.
 */
export function normalizeRemotePattern(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;

  // Bỏ scheme (https://, http://, ssh://, git://, git+ssh://).
  const schemeRe = /^[a-z][a-z0-9+.-]*:\/\//;
  const hasScheme = schemeRe.test(value);
  value = value.replace(schemeRe, '');
  // Bỏ phần user (git@, user@).
  value = value.replace(/^[^@/]+@/, '');
  if (hasScheme) {
    // URL có scheme: `host:22/org/repo` là cổng → bỏ cổng.
    value = value.replace(/^([^/:]+):\d+\//, '$1/');
  } else {
    // Dạng scp: `host:org/repo` → `host/org/repo` (org toàn số vẫn là org, không phải cổng).
    value = value.replace(/^([^/:]+):/, '$1/');
  }
  // Bỏ `/` và `.git` ở cuối.
  value = value
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');

  const parts = value.split('/');
  if (parts.length !== 3) return null;
  const [host, org, repo] = parts;
  if (!HOST_RE.test(host)) return null;
  if (!isValidSegment(org)) return null;
  if (repo !== '*' && !isValidSegment(repo)) return null;
  return `${host}/${org}/${repo}`;
}
