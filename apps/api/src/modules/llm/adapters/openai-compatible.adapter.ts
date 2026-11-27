import { llmError } from '../llm-errors.js';
import type {
  LlmAdapter,
  LlmCompleteRequest,
  LlmCompletion,
} from './adapter.js';

/** Chat Completions theo chuẩn OpenAI (OpenAI, OpenRouter, Ollama...). Bản thật làm ở PR sau của M6.1. */
export class OpenAiCompatibleAdapter implements LlmAdapter {
  complete(_req: LlmCompleteRequest): Promise<LlmCompletion> {
    return Promise.reject(
      llmError('llm_provider_error', 'Chưa hỗ trợ provider openai_compatible'),
    );
  }
}
