import type {
  LlmAdapter,
  LlmCompleteRequest,
  LlmCompletion,
} from './adapter.js';
import {
  classifyProviderError,
  objectRootSchema,
  providerFetch,
  readJson,
  readProviderError,
  trimBase,
} from './http.js';
import { llmError } from '../llm-errors.js';

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null; refusal?: string | null };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Structured Outputs `strict: true` của OpenAI chỉ nhận schema mà mọi object có
 * `additionalProperties: false` và `required` đủ mọi property. Schema khác gửi `strict: false`.
 */
export function isStrictCompatible(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(isStrictCompatible);
  if (!schema || typeof schema !== 'object') return true;
  const node = schema as Record<string, unknown>;
  if (node.type === 'object' || node.properties) {
    const properties = (node.properties ?? {}) as Record<string, unknown>;
    const required = new Set((node.required as string[] | undefined) ?? []);
    if (node.additionalProperties !== false) return false;
    if (Object.keys(properties).some((key) => !required.has(key))) return false;
  }
  return Object.values(node).every(isStrictCompatible);
}

type ResponseFormatMode = 'json_schema' | 'json_object';

/**
 * Chat Completions theo chuẩn OpenAI (`POST {base}/chat/completions`): OpenAI, OpenRouter, Ollama, LM Studio...
 * Ép JSON bằng `response_format: json_schema`; server báo không hỗ trợ (400 nhắc `response_format`) thì
 * thử lại bằng `json_object` (schema vẫn nằm trong system prompt, `LlmService` validate lại).
 * Key rỗng (Ollama) thì không gửi header `Authorization`.
 */
export class OpenAiCompatibleAdapter implements LlmAdapter {
  async complete(req: LlmCompleteRequest): Promise<LlmCompletion> {
    if (!req.baseUrl) {
      throw llmError(
        'llm_provider_error',
        'Provider openai_compatible cần baseUrl',
      );
    }
    const url = `${trimBase(req.baseUrl)}/chat/completions`;
    const { schema, wrapped } = objectRootSchema(req.jsonSchema);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`;

    let mode: ResponseFormatMode = 'json_schema';
    let tokenParam: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';
    // Tối đa 3 lần: bản đầu, fallback json_object, fallback max_completion_tokens.
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = {
        model: req.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        [tokenParam]: req.maxOutputTokens,
        response_format:
          mode === 'json_schema'
            ? {
                type: 'json_schema',
                json_schema: {
                  name: 'respond',
                  schema,
                  strict: isStrictCompatible(schema),
                },
              }
            : { type: 'json_object' },
      };
      const res = await providerFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!res.ok) {
        const info = await readProviderError(res);
        if (info.status === 400 || info.status === 422) {
          const text = `${info.message} ${info.raw}`;
          if (
            mode === 'json_schema' &&
            /response_format|json_schema/i.test(text)
          ) {
            mode = 'json_object';
            continue;
          }
          if (
            tokenParam === 'max_tokens' &&
            /max_tokens/.test(text) &&
            /max_completion_tokens/.test(text)
          ) {
            tokenParam = 'max_completion_tokens';
            continue;
          }
        }
        throw classifyProviderError(info);
      }

      const data = await readJson<ChatCompletionResponse>(res);
      const content = data.choices?.[0]?.message?.content ?? '';
      return {
        text: wrapped ? unwrapValue(content) : content,
        inputTokens: data.usage?.prompt_tokens ?? null,
        outputTokens: data.usage?.completion_tokens ?? null,
      };
    }
    throw llmError(
      'llm_provider_error',
      'Nhà cung cấp AI không nhận định dạng yêu cầu',
    );
  }
}

/** Bỏ lớp `{ value }` đã bọc cho schema gốc không phải object; sai dạng thì trả nguyên để LlmService báo lỗi. */
function unwrapValue(content: string): string {
  try {
    const parsed = JSON.parse(content) as { value?: unknown };
    return 'value' in parsed ? JSON.stringify(parsed.value) : content;
  } catch {
    return content;
  }
}
