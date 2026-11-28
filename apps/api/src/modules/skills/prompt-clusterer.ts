/**
 * Gom cụm prompt lặp lại (Skill Finder S0, M6.11). Heuristic thuần: không gọi LLM, không đọc DB, không log nội dung.
 * Thiết kế: docs/AI_PLAN.md mục 3.2.
 *
 * Quy trình mỗi prompt: bỏ prompt rác, quá ngắn hoặc quá dài → chuẩn hóa NFC (giữ chữ có dấu) → bỏ khối code, URL,
 * đường dẫn, chuỗi trong ngoặc kép → tách từ → bỏ từ dừng (Việt và Anh), từ có chữ số, từ một ký tự → "dấu vân tay" là
 * 4 từ đầu tiên sau khi sắp xếp các từ khóa không trùng theo thứ tự chữ cái. Prompt cùng dấu vân tay vào một cụm;
 * cụm cần đủ số lần lặp tối thiểu.
 *
 * Khác với bản gốc của ai-engineering-coach: bản gốc xóa mọi ký tự ngoài `a-z` nên làm hỏng tiếng Việt; ở đây dùng
 * `\p{L}` của Unicode và thêm từ dừng tiếng Việt.
 *
 * Giới hạn đã biết: dấu vân tay chỉ bắt được các prompt chia sẻ cùng những từ khóa đứng đầu bảng chữ cái, nên cụm có thể
 * thiếu (hai cách nói cùng một việc nhưng khác từ) hoặc đôi khi lẫn. Đây là gợi ý, bước lọc bằng AI (S1) làm sau.
 */

export const MIN_PROMPT_CHARS = 15;
export const MAX_PROMPT_CHARS = 2000;
/** Cần ít nhất ngần này từ khóa thì mới có dấu vân tay đáng tin. */
export const MIN_KEYWORDS = 3;
export const FINGERPRINT_TOKENS = 4;
export const MIN_REPEATS = 3;
export const MAX_CLUSTERS = 200;
export const LABEL_MAX = 200;
export const EXCERPT_MAX = 160;
const EXAMPLES_PER_CLUSTER = 3;

export interface PromptInput {
  userId: string;
  sessionId: string;
  turnSeq: number;
  ts: Date;
  text: string;
}

export interface ClusterOccurrence {
  userId: string;
  sessionId: string;
  turnSeq: number;
  ts: Date;
  excerpt: string;
}

export interface PromptCluster {
  fingerprint: string;
  label: string;
  count: number;
  userCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Mọi người gõ, nhiều lần nhất trước. */
  users: { userId: string; count: number }[];
  /** Tối đa 3 lần xuất hiện gần nhất. */
  examples: ClusterOccurrence[];
}

export interface ClusterResult {
  /** Số prompt qua bộ lọc (có dấu vân tay). */
  promptsAnalyzed: number;
  /** Số prompt nằm trong các cụm đủ số lần lặp. */
  promptsClustered: number;
  /** Số cụm đủ số lần lặp (có thể lớn hơn số cụm trả về khi vượt `maxClusters`). */
  clusterCount: number;
  clusters: PromptCluster[];
}

export interface ClusterOptions {
  minRepeats?: number;
  maxClusters?: number;
}

/** Prompt rác: trả lời xã giao hoặc lệnh một từ, không có nội dung để gom. */
const JUNK =
  /^(?:ok(?:ay|e)?|yes|no|y|n|continue|go on|proceed|tiếp(?: tục)?(?: đi)?|làm đi|chạy đi|cảm ơn|thanks?(?: you)?|được rồi|đồng ý|xong|done|tốt|good)[\s.!?,~]*$/iu;

const STOP_WORDS_EN = [
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from',
  'into', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'can', 'could', 'would',
  'should', 'will', 'shall', 'may', 'please', 'pls', 'just', 'now', 'also', 'as', 'not', 'no', 'yes', 'ok', 'okay',
  'again', 'all', 'any', 'some', 'there', 'here', 'what', 'which', 'who', 'how', 'when', 'where', 'why', 'let', 'lets',
  'want', 'need', 'help', 'thanks', 'thank',
];
const STOP_WORDS_VI = [
  'và', 'là', 'của', 'cho', 'các', 'một', 'những', 'này', 'đó', 'kia', 'nhé', 'nhỉ', 'nha', 'nhá', 'ạ', 'ơi', 'giúp',
  'mình', 'tôi', 'bạn', 'em', 'anh', 'chị', 'hãy', 'vui', 'lòng', 'với', 'để', 'thì', 'mà', 'cũng', 'đã', 'đang', 'sẽ',
  'rồi', 'nữa', 'thêm', 'luôn', 'đi', 'được', 'ra', 'vào', 'lại', 'khi', 'nào', 'gì', 'sao', 'cần', 'muốn', 'có', 'bị',
  'cái', 'còn', 'ở', 'trên', 'dưới', 'từ', 'tới', 'đến', 'như', 'nếu', 'hay', 'hoặc', 'vì', 'nên', 'thôi', 'ừ', 'à',
  'ờ', 'vậy', 'thế', 'nhiều', 'rất', 'quá', 'lắm', 'xin', 'làm', 'tiếp', 'tục', 'cảm', 'ơn',
];
const STOP_WORDS = new Set([...STOP_WORDS_EN, ...STOP_WORDS_VI]);

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** So sánh theo mã ký tự, không phụ thuộc locale của máy. */
const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function cut(text: string, max: number): string {
  const chars = Array.from(text); // đếm theo ký tự Unicode, không chẻ đôi cặp surrogate
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** Bỏ khối code, URL, đường dẫn, tên file, chuỗi trong ngoặc kép: phần dễ khác nhau giữa các lần gõ. */
function stripNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(?:[A-Za-z]:)?[\\/]?(?:[\w.@-]+[\\/])+[\w.@-]+/g, ' ')
    .replace(/\b[\w-]+\.(?:tsx?|jsx?|json|md|rs|py|go|java|cs|css|html|ya?ml|toml|sql|sh|ps1|lock|env)\b/gi, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ');
}

/**
 * Từ khóa của một prompt, hoặc `null` nếu prompt bị loại (rác, quá ngắn, quá dài, ít từ khóa).
 * Giữ nguyên chữ có dấu: chuẩn hóa NFC rồi tách theo `\p{L}`.
 */
export function keywordsOf(text: string): string[] | null {
  const normalized = text.normalize('NFC').trim();
  const length = Array.from(normalized).length;
  if (length < MIN_PROMPT_CHARS || length > MAX_PROMPT_CHARS) return null;
  if (JUNK.test(normalized)) return null;
  // Tách theo chữ và số rồi bỏ cả từ có chữ số (phiên bản, mã, số dòng), kẻo `node18` còn lại `node`.
  const words = stripNoise(normalized).toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const keywords = new Set<string>();
  for (const word of words) {
    if (/\p{N}/u.test(word)) continue;
    if (Array.from(word).length < 2 || STOP_WORDS.has(word)) continue;
    keywords.add(word);
  }
  return keywords.size >= MIN_KEYWORDS ? [...keywords] : null;
}

/** 4 từ khóa đầu tiên sau khi sắp xếp (theo mã ký tự, không phụ thuộc locale của máy). */
export function fingerprintOf(keywords: readonly string[]): string {
  return [...keywords]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, FINGERPRINT_TOKENS)
    .join(' ');
}

interface Entry {
  input: PromptInput;
  length: number;
}

export function clusterPrompts(
  inputs: readonly PromptInput[],
  options: ClusterOptions = {},
): ClusterResult {
  const minRepeats = options.minRepeats ?? MIN_REPEATS;
  const maxClusters = options.maxClusters ?? MAX_CLUSTERS;

  const groups = new Map<string, Entry[]>();
  let analyzed = 0;
  for (const input of inputs) {
    const keywords = keywordsOf(input.text);
    if (!keywords) continue;
    analyzed += 1;
    const fingerprint = fingerprintOf(keywords);
    const list = groups.get(fingerprint) ?? [];
    list.push({ input, length: Array.from(input.text).length });
    groups.set(fingerprint, list);
  }

  const clusters: PromptCluster[] = [];
  let clustered = 0;
  for (const [fingerprint, entries] of groups) {
    if (entries.length < minRepeats) continue;
    clustered += entries.length;
    const byTime = [...entries].sort(
      (a, b) =>
        b.input.ts.getTime() - a.input.ts.getTime() ||
        a.input.turnSeq - b.input.turnSeq ||
        (a.input.sessionId < b.input.sessionId ? -1 : 1),
    );
    const perUser = new Map<string, number>();
    for (const e of entries) perUser.set(e.input.userId, (perUser.get(e.input.userId) ?? 0) + 1);
    const users = [...perUser]
      .map(([userId, count]) => ({ userId, count }))
      .sort((a, b) => b.count - a.count || (a.userId < b.userId ? -1 : 1));
    // Prompt tiêu biểu: độ dài vừa (giữa danh sách xếp theo độ dài), bớt lẫn prompt quá ngắn hay quá dài.
    // Hòa độ dài và thời điểm thì so tiếp nội dung, session, turn: nhãn không phụ thuộc thứ tự đầu vào.
    const byLength = [...entries].sort(
      (a, b) =>
        a.length - b.length ||
        a.input.ts.getTime() - b.input.ts.getTime() ||
        compareStrings(a.input.text, b.input.text) ||
        compareStrings(a.input.sessionId, b.input.sessionId) ||
        a.input.turnSeq - b.input.turnSeq,
    );
    const representative = byLength[Math.floor((byLength.length - 1) / 2)];
    clusters.push({
      fingerprint,
      label: cut(collapse(representative.input.text.normalize('NFC')), LABEL_MAX),
      count: entries.length,
      userCount: users.length,
      firstSeenAt: byTime[byTime.length - 1].input.ts,
      lastSeenAt: byTime[0].input.ts,
      users,
      examples: byTime.slice(0, EXAMPLES_PER_CLUSTER).map(({ input }) => ({
        userId: input.userId,
        sessionId: input.sessionId,
        turnSeq: input.turnSeq,
        ts: input.ts,
        excerpt: cut(collapse(input.text.normalize('NFC')), EXCERPT_MAX),
      })),
    });
  }

  clusters.sort(
    (a, b) =>
      b.count - a.count ||
      b.lastSeenAt.getTime() - a.lastSeenAt.getTime() ||
      (a.fingerprint < b.fingerprint ? -1 : 1),
  );
  return {
    promptsAnalyzed: analyzed,
    promptsClustered: clustered,
    clusterCount: clusters.length,
    clusters: clusters.slice(0, maxClusters),
  };
}

export interface FullOccurrence {
  userId: string;
  sessionId: string;
  turnSeq: number;
  ts: Date;
  /** Nguyên văn prompt (đã NFC), dùng cho nút AI; KHÔNG đưa ra danh sách cụm. */
  text: string;
}

/**
 * Các lần xuất hiện gần nhất của một cụm (theo dấu vân tay), kèm nguyên văn prompt, để gửi cho AI (S1, S2).
 * Cùng bộ lọc và cùng cách chuẩn hóa với {@link clusterPrompts} nên ra đúng các prompt của cụm đó.
 */
export function occurrencesOf(
  inputs: readonly PromptInput[],
  fingerprint: string,
  limit: number,
): FullOccurrence[] {
  const matched: FullOccurrence[] = [];
  for (const input of inputs) {
    const keywords = keywordsOf(input.text);
    if (!keywords || fingerprintOf(keywords) !== fingerprint) continue;
    matched.push({
      userId: input.userId,
      sessionId: input.sessionId,
      turnSeq: input.turnSeq,
      ts: input.ts,
      text: input.text.normalize('NFC'),
    });
  }
  return matched
    .sort(
      (a, b) =>
        b.ts.getTime() - a.ts.getTime() ||
        a.turnSeq - b.turnSeq ||
        compareStrings(a.sessionId, b.sessionId),
    )
    .slice(0, limit);
}
