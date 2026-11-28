/** Nguồn catalog: chỉ nhận repo GitHub công khai, để server không bị lợi dụng gọi URL tùy ý (SSRF). */
export interface GithubRepoRef {
  owner: string;
  repo: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Đọc URL `https://github.com/{owner}/{repo}` (chấp nhận `.git`, dấu `/` cuối, `/tree/<nhánh>`, `www.`).
 * Trả `null` với mọi thứ khác (http, host khác, thiếu repo, có user:pass, port, query).
 * Nhánh trong `/tree/<nhánh>` bị bỏ: server luôn đọc nhánh mặc định.
 */
export function parseGithubRepoUrl(input: string): GithubRepoRef | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com')
    return null;
  if (url.username || url.password || url.port) return null;
  if (url.search || url.hash) return null;

  const parts = url.pathname.split('/').filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  if (parts.length > 2 && parts[2] !== 'tree') return null;
  if (parts.length === 3) return null; // `/tree` không kèm nhánh

  const owner = parts[0];
  const repo = parts[1].endsWith('.git') ? parts[1].slice(0, -4) : parts[1];
  if (!OWNER.test(owner) || !REPO.test(repo)) return null;
  if (repo === '.' || repo === '..') return null;
  return { owner, repo };
}

/** URL chuẩn của repo, dùng làm khóa duy nhất của nguồn (không phân biệt hoa thường ở phần owner và repo). */
export function normalizeGithubUrl(ref: GithubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}`;
}
