export const CATALOG_NAME_MAX = 80;
export const CATALOG_DESCRIPTION_MAX = 300;

export interface SkillFrontmatter {
  name: string;
  description: string;
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

const cut = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"'))
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'"))
    return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * Đọc `name` và `description` trong front matter của một `SKILL.md` (tập con của YAML: giá trị một dòng,
 * có nháy, hoặc khối `>` / `|` thụt lề). Đầu vào có thể là đoạn đầu của file (đã bị cắt giữa chừng).
 * Thiếu `description` thì `null`; thiếu `name` thì dùng `fallbackName`.
 */
export function parseSkillFrontmatter(
  text: string,
  fallbackName: string,
): SkillFrontmatter | null {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  const fm = end === -1 ? lines.slice(1) : lines.slice(1, end);

  const read = (key: string): string | null => {
    const at = fm.findIndex((line) => new RegExp(`^${key}:`).test(line));
    if (at === -1) return null;
    const rest = fm[at].slice(key.length + 1).trim();
    if (rest === '' || /^[>|][+-]?$/.test(rest)) {
      const block: string[] = [];
      for (const line of fm.slice(at + 1)) {
        if (line.trim() !== '' && !/^\s/.test(line)) break;
        block.push(line.trim());
      }
      return squash(block.join(' '));
    }
    return squash(unquote(rest));
  };

  const description = read('description');
  if (!description) return null;
  const name = read('name') || fallbackName;
  if (!name) return null;
  return {
    name: cut(name, CATALOG_NAME_MAX),
    description: cut(description, CATALOG_DESCRIPTION_MAX),
  };
}
