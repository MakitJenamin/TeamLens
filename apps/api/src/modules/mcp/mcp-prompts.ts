import { createRequire } from 'node:module';
import { z } from 'zod';
import type { UserRole } from '../../db/schema/users.js';

const require = createRequire(import.meta.url);

export interface McpPromptDefinition {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  /** Lời nhắc gửi cho agent; `{{tên}}` được thay bằng giá trị argument cùng tên. */
  template: string;
}

const NAMES = ['coach-me', 'find-skills', 'weekly-review'] as const;

/** Prompt chỉ dành cho leader (chỉ leader mới có dữ liệu cả team để dùng). */
const LEADER_ONLY: ReadonlySet<string> = new Set(['weekly-review']);

/** Định nghĩa đọc từ contract `packages/schema/mcp/prompts/<tên>.json`. */
const PROMPTS: McpPromptDefinition[] = NAMES.map(
  (name) =>
    require(`@teamlens/schema/mcp/prompts/${name}.json`) as McpPromptDefinition,
);

/** Prompt người gọi được dùng. Member không thấy prompt dành cho leader. */
export function listPrompts(role: UserRole): McpPromptDefinition[] {
  return PROMPTS.filter((p) => role === 'leader' || !LEADER_ONLY.has(p.name));
}

export class PromptError extends Error {}

/**
 * Dựng nội dung prompt. Argument bắt buộc phải có; argument tên kết thúc bằng `Id` phải là UUID để không thể
 * nhét chuỗi lạ (chỉ dẫn) vào lời nhắc. Trả `undefined` khi prompt không tồn tại hoặc người gọi không được dùng.
 */
export function renderPrompt(
  role: UserRole,
  name: string,
  args: Record<string, string> | undefined,
): { description: string; text: string } | undefined {
  const prompt = listPrompts(role).find((p) => p.name === name);
  if (!prompt) return undefined;
  const values: Record<string, string> = {};
  for (const def of prompt.arguments) {
    const value = args?.[def.name];
    if (value === undefined || value === '') {
      if (def.required) throw new PromptError(`Thiếu tham số bắt buộc "${def.name}".`);
      continue;
    }
    if (def.name.endsWith('Id') && !z.uuid().safeParse(value).success) {
      throw new PromptError(`Tham số "${def.name}" phải là UUID.`);
    }
    values[def.name] = value;
  }
  const text = prompt.template.replace(
    /\{\{(\w+)\}\}/g,
    (_match, argName: string) => values[argName] ?? '',
  );
  return { description: prompt.description, text };
}
