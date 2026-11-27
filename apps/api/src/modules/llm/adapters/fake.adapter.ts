import type {
  LlmAdapter,
  LlmAdapters,
  LlmCompleteRequest,
  LlmCompletion,
} from './adapter.js';

/** Phản hồi giả treo tới khi bị hủy (thử timeout). */
export const FAKE_HANG = Symbol('FAKE_HANG');

/**
 * Một phản hồi giả:
 * - `string`: văn bản model trả nguyên văn (có thể là JSON sai để thử `llm_bad_output`).
 * - object không phải `Error`: được `JSON.stringify`.
 * - `Error` (vd `llmError('llm_key_invalid')`): ném ra.
 * - `FAKE_HANG`: treo tới khi `signal` bị hủy (thử timeout).
 */
export type FakeResponse = string | object | Error | typeof FAKE_HANG;

/** Adapter giả cho test: trả lần lượt các phản hồi đã xếp hàng, ghi lại mọi request. */
export class FakeLlmAdapter implements LlmAdapter {
  readonly calls: LlmCompleteRequest[] = [];
  private readonly queue: FakeResponse[] = [];
  /** Phản hồi khi hàng đợi rỗng. */
  fallback: FakeResponse = { ok: true };
  usage = { inputTokens: 10, outputTokens: 5 };

  /** Xếp hàng phản hồi cho các lần gọi kế tiếp. */
  enqueue(...responses: FakeResponse[]): this {
    this.queue.push(...responses);
    return this;
  }

  reset(): void {
    this.calls.length = 0;
    this.queue.length = 0;
    this.fallback = { ok: true };
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompletion> {
    this.calls.push(req);
    const response = this.queue.length > 0 ? this.queue.shift() : this.fallback;
    if (response === FAKE_HANG) {
      return new Promise<LlmCompletion>((_, reject) => {
        const abort = () => reject(new Error('aborted'));
        if (req.signal.aborted) abort();
        else req.signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (response instanceof Error) throw response;
    return {
      text: typeof response === 'string' ? response : JSON.stringify(response),
      ...this.usage,
    };
  }
}

/** Map adapter dùng chung một `FakeLlmAdapter` cho mọi provider, để override `LLM_ADAPTERS` trong test. */
export function fakeAdapters(fake: FakeLlmAdapter): LlmAdapters {
  return { anthropic: fake, openai_compatible: fake };
}
