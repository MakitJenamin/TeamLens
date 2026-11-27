import type { LlmProvider } from '../llm.types.js';

/** Một lần gọi provider: đã ghép prompt, đã có JSON Schema để ép đầu ra. */
export interface LlmCompleteRequest {
  /** null: địa chỉ mặc định của provider. */
  baseUrl: string | null;
  model: string;
  /** Có thể rỗng (vd Ollama không cần key). Không bao giờ ghi log. */
  apiKey: string;
  system: string;
  user: string;
  /** JSON Schema của đầu ra (từ `z.toJSONSchema`). */
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  /** Hủy khi quá thời gian chờ; adapter phải truyền cho `fetch`. */
  signal: AbortSignal;
}

export interface LlmCompletion {
  /** Văn bản JSON do model trả (có thể còn bọc ```json, `LlmService` tự bóc). */
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Adapter cho một provider. Lỗi phải ném bằng `llmError(...)` (`llm-errors.ts`) đúng mã;
 * lỗi lạ được `LlmService` bọc thành `llm_provider_error`.
 */
export interface LlmAdapter {
  complete(req: LlmCompleteRequest): Promise<LlmCompletion>;
}

/** Map provider → adapter. Test override token này bằng `FakeLlmAdapter`. */
export type LlmAdapters = Record<LlmProvider, LlmAdapter>;

/** Token DI của map adapter: `@Inject(LLM_ADAPTERS) adapters: LlmAdapters`. */
export const LLM_ADAPTERS = Symbol('LLM_ADAPTERS');

/** Token DI tùy chọn cho thời gian chờ mỗi lần gọi (ms), mặc định 60 giây. */
export const LLM_TIMEOUT_MS = Symbol('LLM_TIMEOUT_MS');
