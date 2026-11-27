import { llmError } from '../llm-errors.js';
import type {
  LlmAdapter,
  LlmCompleteRequest,
  LlmCompletion,
} from './adapter.js';

/** Messages API của Anthropic. Bản thật làm ở PR sau của M6.1. */
export class AnthropicAdapter implements LlmAdapter {
  complete(_req: LlmCompleteRequest): Promise<LlmCompletion> {
    return Promise.reject(
      llmError('llm_provider_error', 'Chưa hỗ trợ provider anthropic'),
    );
  }
}
