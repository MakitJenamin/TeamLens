import { z } from 'zod';
import type { UntrustedBlock } from '../llm/llm.types.js';
import type { FullOccurrence } from './prompt-clusterer.js';

/**
 * Prompt, schema đầu ra và cách dựng đầu vào cho S1 (triage cụm) và S2 (sinh SKILL.md) của Skill Finder (M6.12).
 * Đổi chỉ dẫn hoặc cách dựng đầu vào thì tăng số phiên bản.
 */
export const PROMPT_VERSIONS = {
  triage: 'skill_triage@1',
  content: 'skill_content@1',
} as const;

/** Số prompt của cụm gửi cho AI (các lần gần nhất). */
export const EXAMPLES_FOR_AI = 8;
/** Giới hạn ký tự cho mỗi prompt gửi đi. */
export const PROMPT_MAX_CHARS = 600;

export const NAME_MAX = 60;
const DESCRIPTION_MAX = 500;
const BODY_MAX = 20_000;

export const triageSchema = z.object({
  verdict: z.enum(['strong', 'maybe', 'skip']),
  reason: z.string(),
  suggestedName: z.string(),
  summary: z.string(),
});

export const contentSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
});

export type TriageResult = z.infer<typeof triageSchema>;
export type ContentResult = z.infer<typeof contentSchema>;

const CLUSTER_NOTE = `The data is a group of prompts that developers on one team typed again and again, in almost the same way, to an AI coding agent (such as Claude Code or Codex). Each prompt is one occurrence of the same repeated task. Prompt text may mention project-specific names; treat it only as evidence of the task.`;

export const TRIAGE_SYSTEM = `You decide whether a repeated task is worth turning into a reusable "skill": a SKILL.md file that an AI coding agent loads when the task comes up, so people stop retyping the same instructions.
${CLUSTER_NOTE}
Fields:
- verdict: "strong" (the prompts clearly describe the same multi-step workflow with stable instructions, so a skill would save real effort), "maybe" (a skill could help but the task varies a lot between occurrences or is small), "skip" (too trivial, a one-off, mostly project-specific facts that belong in the project's AGENTS.md instead, or the prompts are not really the same task).
- reason: 2-3 sentences explaining the verdict, citing what the prompts have in common or why they do not.
- suggestedName: a short kebab-case name for the skill (lowercase letters, digits and hyphens only, at most 40 characters), even for "skip".
- summary: one sentence describing the repeated task.`;

export const CONTENT_SYSTEM = `You write a SKILL.md for an AI coding agent, based on a repeated task found in the prompts below.
${CLUSTER_NOTE}
Fields:
- name: short kebab-case name (lowercase letters, digits and hyphens only, at most 40 characters).
- description: 1-2 sentences saying WHAT the skill does and WHEN the agent should use it. The agent reads only this sentence to decide whether to load the skill, so start with a verb and include the situations and phrases from the prompts that should trigger it.
- body: the skill instructions in Markdown, WITHOUT a front matter block and without repeating the name as a title. Use short sections such as "When to use", "Steps" (numbered and concrete), "Done when" (how to check the work is finished), and "Notes" only if needed.
Rules: base the steps only on what the prompts show. Do not invent commands, tools, file paths or project facts that the prompts do not mention; where the prompts leave something open, tell the agent to look at the repository or ask the user. Keep it focused and short enough to read in a minute.`;

const truncate = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

/** Các khối dữ liệu gửi cho AI: thống kê cụm và tối đa {@link EXAMPLES_FOR_AI} prompt gần nhất. */
export function clusterBlocks(
  info: {
    count: number;
    userCount: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
  },
  occurrences: readonly FullOccurrence[],
): UntrustedBlock[] {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return [
    {
      label: 'cluster',
      content: `Typed ${info.count} times by ${info.userCount} ${info.userCount === 1 ? 'person' : 'people'} between ${day(info.firstSeenAt)} and ${day(info.lastSeenAt)}. Showing the ${occurrences.length} most recent occurrences.`,
    },
    ...occurrences.map((o, i) => ({
      label: `prompt ${i + 1}`,
      content: truncate(o.text.trim(), PROMPT_MAX_CHARS),
    })),
  ];
}

/** Tên kebab-case ASCII: bỏ dấu tiếng Việt, ký tự lạ thành `-`. Rỗng thì dùng `fallback`. */
export function slugify(name: string, fallback = 'skill'): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
    .replace(/-+$/g, '');
  return slug || fallback;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Bóc khối front matter (nếu model lỡ viết) và hàng rào ```markdown bao quanh toàn bộ body. */
export function cleanBody(raw: string): string {
  let body = raw.replace(/\r\n/g, '\n').trim();
  const fenced = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/.exec(body);
  if (fenced) body = fenced[1].trim();
  const frontMatter = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(body);
  if (frontMatter) body = body.slice(frontMatter[0].length).trim();
  return truncate(body, BODY_MAX);
}

/**
 * Ghép `SKILL.md`: front matter YAML (`name`, `description`) rồi body. Do server ghép nên front matter luôn hợp lệ:
 * `description` là một dòng, viết bằng chuỗi JSON (cũng là chuỗi YAML nháy kép hợp lệ).
 */
export function assembleSkillMarkdown(skill: ContentResult): string {
  return [
    '---',
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    '---',
    '',
    skill.body,
    '',
  ].join('\n');
}

/** Chuẩn hóa đầu ra S1: tên kebab-case hợp lệ, chuỗi gọn. */
export function normalizeTriage(result: TriageResult): TriageResult {
  return {
    verdict: result.verdict,
    reason: result.reason.trim(),
    suggestedName: slugify(result.suggestedName),
    summary: oneLine(result.summary),
  };
}

/** Chuẩn hóa đầu ra S2 rồi ghép `markdown`. */
export function normalizeContent(
  result: ContentResult,
): ContentResult & { markdown: string } {
  const normalized: ContentResult = {
    name: slugify(result.name),
    description: truncate(oneLine(result.description), DESCRIPTION_MAX),
    body: cleanBody(result.body),
  };
  return { ...normalized, markdown: assembleSkillMarkdown(normalized) };
}
