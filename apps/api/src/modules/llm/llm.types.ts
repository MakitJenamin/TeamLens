import type { AiKind, AiSubjectType } from '@teamlens/schema';
import type { z } from 'zod';
import type { aiResults, LlmProvider } from '../../db/schema/ai.js';

export type { AiKind, AiSubjectType, LlmProvider };
export type AiLocale = 'vi' | 'en';

/** Một khối dữ liệu không đáng tin (nội dung turn, prompt người dùng...). */
export interface UntrustedBlock {
  /** Nhãn ngắn mô tả khối, vd `turn 12`. Chỉ giữ chữ, số, khoảng trắng và `_.:#-`. */
  label: string;
  content: string;
}

/** Một lần gọi LLM của một tính năng. */
export interface LlmTask<T> {
  kind: AiKind;
  subjectType: AiSubjectType;
  subjectId: string;
  /** Chủ dữ liệu (vd chủ session), để xóa dữ liệu một người thì xóa luôn kết quả về người đó. */
  subjectUserId?: string | null;
  locale: AiLocale;
  /** Phiên bản prompt, vd `session_summary@1`. Đổi prompt thì tăng số. */
  promptVersion: string;
  /** Chỉ dẫn của tính năng. Không được chứa dữ liệu người dùng (đưa vào `untrusted`). */
  system: string;
  /** Dữ liệu không đáng tin; `LlmService` tự bọc sau câu chặn injection. */
  untrusted: UntrustedBlock[];
  /** Schema đầu ra; `LlmService` chuyển sang JSON Schema để ép provider và validate lại bằng zod. */
  schema: z.ZodType<T>;
  /** Giới hạn token đầu ra, mặc định 2048. */
  maxOutputTokens?: number;
}

type AiResultDbRow = typeof aiResults.$inferSelect;

/** Bản ghi `ai_results` với `result` đã validate theo schema của task. */
export type AiResultRow<T = unknown> = Omit<AiResultDbRow, 'result'> & {
  result: T;
};

/** Cấu hình key đã giải mã (chỉ dùng nội bộ, không bao giờ trả qua API hay ghi log). */
export interface LlmKeyConfig {
  provider: LlmProvider;
  baseUrl: string | null;
  model: string;
  apiKey: string;
}

export interface FindResultsFilter {
  kind?: AiKind;
  subjectType: AiSubjectType;
  subjectIds: string[];
  locale?: AiLocale;
}
