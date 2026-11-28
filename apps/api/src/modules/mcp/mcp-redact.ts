/**
 * Cửa ra che secret của MCP (AI_PLAN mục 4.1): mọi kết quả tool đi qua đây trước khi trả cho agent.
 *
 * Dữ liệu trên server đã được CLI che từ máy thành viên (tl-core::redact), nên đây là lớp phòng thủ
 * thêm, KHÔNG phải bộ che đầy đủ: chỉ gồm các mẫu chắc chắn, ít báo nhầm. Không gọi mạng, không log.
 */

interface Rule {
  kind: string;
  pattern: RegExp;
  /** Có `secret` thì chỉ che phần đó (giữ lại tên biến, tên người dùng của URL...). */
  group?: boolean;
}

const RULES: readonly Rule[] = [
  {
    kind: 'private_key',
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { kind: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: 'github_token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  },
  { kind: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai_key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  // Token của chính TeamLens: device token `tld_`, token cá nhân `tlp_`.
  { kind: 'teamlens_token', pattern: /\btl[dp]_[A-Za-z0-9_-]{20,}/g },
  {
    kind: 'url_password',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?<secret>[^\s@/]{3,})@/gi,
    group: true,
  },
  {
    kind: 'secret_assignment',
    pattern:
      /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?(?<secret>[^\s"'`,;]{8,})/gi,
    group: true,
  },
];

/** Che secret trong một chuỗi bằng `[REDACTED:<loại>]`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      const groups = args.at(-1);
      const secret =
        rule.group && typeof groups === 'object' && groups !== null
          ? (groups as { secret?: string }).secret
          : undefined;
      const mark = `[REDACTED:${rule.kind}]`;
      const whole = String(args[0]);
      if (secret === undefined) return mark;
      // Chỉ thay phần secret, giữ phần còn lại của đoạn khớp.
      const at = whole.lastIndexOf(secret);
      return at < 0
        ? mark
        : whole.slice(0, at) + mark + whole.slice(at + secret.length);
    });
  }
  return out;
}

/** Che secret trong mọi chuỗi của một giá trị JSON (không đổi cấu trúc, không đổi khóa). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactDeep(item);
    }
    return out as T;
  }
  return value;
}
