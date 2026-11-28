/** Một skill trong catalog cộng đồng (tên và mô tả lấy từ front matter của `SKILL.md`). */
export interface CatalogEntry {
  sourceUrl: string;
  name: string;
  description: string;
  skillUrl: string;
}

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'use',
  'when',
  'this',
  'that',
  'from',
  'you',
  'your',
  'skill',
  'skills',
  'user',
  'users',
  'file',
  'files',
  'are',
  'not',
  'can',
  'any',
  'all',
]);

/** Từ khóa thô để so khớp: chữ thường NFC, tách theo ký tự không phải chữ hoặc số, bỏ từ ngắn và từ dừng. */
export function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= 3 && !STOP.has(raw)) out.add(raw);
  }
  return out;
}

/**
 * Xếp catalog theo độ trùng từ khóa với các cụm (từ trùng ở tên tính gấp đôi) rồi lấy tối đa `limit`.
 * Catalog thường bằng tiếng Anh còn prompt có thể bằng tiếng Việt, nên điểm 0 không bị loại: các mục còn lại
 * được giữ theo thứ tự ổn định để LLM tự quyết (giới hạn đã biết, ghi ở README).
 */
export function shortlist(
  entries: readonly CatalogEntry[],
  clusterTexts: readonly string[],
  limit: number,
): CatalogEntry[] {
  const wanted = tokensOf(clusterTexts.join(' '));
  const scored = entries.map((entry, index) => {
    let score = 0;
    for (const t of tokensOf(entry.name)) if (wanted.has(t)) score += 2;
    for (const t of tokensOf(entry.description)) if (wanted.has(t)) score += 1;
    return { entry, index, score };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.entry);
}
