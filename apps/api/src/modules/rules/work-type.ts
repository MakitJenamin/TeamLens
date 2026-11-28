import type { WorkType } from '../../db/schema/sessions.js';
import type { RuleTurn } from './session-engine.js';
import { humanPrompts } from './session-signals.js';

/**
 * Phân loại việc của một session bằng heuristic (B4, M6.7). Không gọi LLM, không đọc DB, không ghi log.
 *
 * Tín hiệu, theo thứ tự ưu tiên:
 * 1. Đường dẫn file bị sửa (diff): phần lớn là file test thì `test`, toàn tài liệu thì `docs`, phần lớn là file hạ tầng
 *    (Dockerfile, CI, terraform, k8s...) thì `ops`. Tính theo số dòng đổi (hoặc số file nếu diff không có số dòng).
 * 2. Từ khóa tiếng Việt và tiếng Anh trong prompt của người dùng. Prompt đầu tiên nặng gấp 3 các prompt sau.
 * 3. Session không sửa file nào mà prompt đầu là câu hỏi thì `question`.
 *
 * Chỉ prompt do người dùng gõ được xét (không xét lời của assistant). Session không có prompt thì `null`.
 */

const BOUNDARY_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const BOUNDARY_AFTER = String.raw`(?![\p{L}\p{N}_])`;

/** Từ hoặc cụm từ khớp nguyên từ (không khớp giữa chữ), không phân biệt hoa thường, hiểu chữ có dấu. */
function words(list: readonly string[]): RegExp {
  const alternation = list
    .map((w) => w.normalize('NFC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, String.raw`\s+`))
    .join('|');
  return new RegExp(`${BOUNDARY_BEFORE}(?:${alternation})${BOUNDARY_AFTER}`, 'giu');
}

type Scored = Exclude<WorkType, 'other' | 'question'>;

const KEYWORDS: Record<Scored, RegExp> = {
  bugfix: words([
    'bug', 'bugs', 'fix', 'fixes', 'fixing', 'fixed', 'crash', 'crashes', 'exception', 'regression', 'broken', 'stack trace',
    'stacktrace', 'error', 'errors', 'failing', 'fails', 'failed', 'not working', "doesn't work", 'wrong',
    'lỗi', 'sửa lỗi', 'bị lỗi', 'sửa bug', 'hỏng', 'treo', 'sập', 'không chạy', 'không hoạt động', 'sai', 'thất bại', 'báo lỗi',
  ]),
  feature: words([
    'add', 'create', 'implement', 'build', 'new feature', 'feature', 'support', 'introduce', 'endpoint', 'page', 'screen',
    'thêm', 'tạo', 'xây dựng', 'làm trang', 'tính năng', 'chức năng', 'hỗ trợ', 'bổ sung', 'màn hình', 'trang mới',
  ]),
  refactor: words([
    'refactor', 'refactoring', 'rename', 'restructure', 'cleanup', 'clean up', 'simplify', 'extract', 'dedupe', 'deduplicate',
    'tái cấu trúc', 'đổi tên', 'dọn code', 'dọn dẹp', 'tách hàm', 'tách file', 'đơn giản hóa', 'gọn lại', 'tối ưu code',
  ]),
  ops: words([
    'deploy', 'deployment', 'ci', 'cd', 'pipeline', 'docker', 'dockerfile', 'kubernetes', 'k8s', 'terraform', 'helm', 'nginx',
    'github actions', 'workflow', 'release', 'infra', 'infrastructure', 'server', 'env', 'ansible', 'caddy',
    'triển khai', 'phát hành', 'hạ tầng', 'máy chủ', 'cấu hình ci', 'biến môi trường',
  ]),
  test: words([
    'test', 'tests', 'unit test', 'unit tests', 'testing', 'test case', 'test cases', 'coverage', 'e2e', 'spec', 'specs',
    'kiểm thử', 'viết test', 'thêm test', 'độ phủ', 'ca kiểm thử',
  ]),
  docs: words([
    'docs', 'doc', 'documentation', 'document', 'readme', 'changelog', 'comment', 'comments', 'jsdoc', 'docstring',
    'tài liệu', 'viết tài liệu', 'chú thích', 'ghi chú', 'hướng dẫn sử dụng',
  ]),
};

/** Khi điểm bằng nhau thì chọn loại đứng trước. */
const PRIORITY: readonly Scored[] = ['bugfix', 'refactor', 'feature', 'ops', 'test', 'docs'];

const QUESTION = words([
  'why', 'what', 'how', 'where', 'which', 'explain', 'what is', 'how do', 'how does', 'can you explain', 'tell me',
  'tại sao', 'vì sao', 'là gì', 'như thế nào', 'làm sao', 'ở đâu', 'giải thích', 'cho mình hỏi', 'cho tôi hỏi', 'khác nhau', 'có nghĩa',
]);

const EDIT_TOOL = /^(?:edit|multiedit|write|notebookedit|apply_patch|str_replace_editor|replace|create_file|write_file)$/i;

const TEST_PATH = /(?:^|[\\/])(?:__tests__|tests?|spec|e2e)[\\/]|[._-](?:test|tests|spec|e2e)\.[a-z0-9]+$|(?:^|[\\/])test_[^\\/]+$|_test\.[a-z0-9]+$/i;
const DOC_PATH = /\.(?:md|mdx|rst|txt|adoc)$|(?:^|[\\/])docs?[\\/]/i;
const OPS_PATH =
  /(?:^|[\\/])(?:dockerfile[^\\/]*|docker-compose[^\\/]*|compose\.ya?ml|caddyfile|\.github[\\/]workflows[\\/][^\\/]+|\.gitlab-ci\.ya?ml|jenkinsfile|[^\\/]+\.tf|[^\\/]+\.tfvars|helm[\\/].+|k8s[\\/].+|kubernetes[\\/].+|deploy[\\/].+|infra[\\/].+|\.env(?:\.[a-z]+)?|nginx\.conf)$/i;

/** Hệ số của prompt đầu tiên so với các prompt sau. */
const FIRST_PROMPT_WEIGHT = 3;
/** Tỉ lệ số dòng đổi tối thiểu để đường dẫn quyết định loại việc. */
const PATH_SHARE = 0.7;
const DOCS_SHARE = 0.9;

function count(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return text.match(pattern)?.length ?? 0;
}

/** Tỉ lệ số dòng đổi nằm ở các file khớp `pattern` (số file nếu diff không có số dòng); 0 khi không có diff. */
function pathShare(turns: readonly RuleTurn[], pattern: RegExp): number {
  let matched = 0;
  let total = 0;
  const seen = new Set<string>();
  for (const turn of turns) {
    const diff = turn.diff;
    if (!diff?.path) continue;
    const loc = Math.max(0, diff.added) + Math.max(0, diff.removed);
    total += loc;
    if (pattern.test(diff.path)) matched += loc;
    seen.add(diff.path);
  }
  if (total > 0) return matched / total;
  if (seen.size === 0) return 0;
  return [...seen].filter((path) => pattern.test(path)).length / seen.size;
}

function hasEdits(turns: readonly RuleTurn[]): boolean {
  return turns.some(
    (t) => t.diff != null || (t.kind === 'tool_call' && t.tool != null && EDIT_TOOL.test(t.tool.name)),
  );
}

/**
 * Loại việc của session, hoặc `null` khi không có prompt của người dùng để xét.
 * Hàm thuần: cùng đầu vào luôn cho cùng kết quả.
 */
export function classifyWorkType(turns: readonly RuleTurn[]): WorkType | null {
  const prompts = humanPrompts(turns)
    .map((t) => (t.text ?? '').normalize('NFC').toLowerCase())
    .filter((text) => text.trim().length > 0);
  if (prompts.length === 0) return null;
  const edited = hasEdits(turns);

  // 1. Đường dẫn: phần lớn thay đổi nằm ở file test, tài liệu hoặc hạ tầng.
  if (edited) {
    if (pathShare(turns, TEST_PATH) >= PATH_SHARE) return 'test';
    if (pathShare(turns, DOC_PATH) >= DOCS_SHARE) return 'docs';
    if (pathShare(turns, OPS_PATH) >= PATH_SHARE) return 'ops';
  }

  // 2. Từ khóa trong prompt.
  const scores = new Map<Scored, number>(PRIORITY.map((type) => [type, 0]));
  prompts.forEach((text, index) => {
    const weight = index === 0 ? FIRST_PROMPT_WEIGHT : 1;
    for (const type of PRIORITY) scores.set(type, scores.get(type)! + weight * Math.min(count(text, KEYWORDS[type]), 3));
  });

  // 3. Không sửa file nào mà prompt đầu là câu hỏi: hỏi đáp.
  const first = prompts[0];
  const asksQuestion = first.includes('?') || count(first, QUESTION) > 0;
  if (!edited && asksQuestion) return 'question';

  let best: Scored | null = null;
  for (const type of PRIORITY) {
    const score = scores.get(type)!;
    if (score > 0 && (best === null || score > scores.get(best)!)) best = type;
  }
  if (best !== null) return best;
  return 'other';
}
