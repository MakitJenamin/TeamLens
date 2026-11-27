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

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/** Tên tool bắt buộc dùng để ép đầu ra JSON theo schema. */
const RESPOND_TOOL = 'respond';

interface AnthropicResponse {
  content?: { type: string; name?: string; input?: unknown; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Messages API của Anthropic (`POST {base}/v1/messages`). Ép đầu ra JSON bằng một tool bắt buộc
 * (`tool_choice: { type: 'tool', name: 'respond' }`) có `input_schema` là JSON Schema của task.
 */
export class AnthropicAdapter implements LlmAdapter {
  async complete(req: LlmCompleteRequest): Promise<LlmCompletion> {
    // Cho phép người dùng nhập base có hoặc không có `/v1`.
    const base = trimBase(req.baseUrl || ANTHROPIC_DEFAULT_BASE_URL).replace(
      /\/v1$/,
      '',
    );
    const { schema, wrapped } = objectRootSchema(req.jsonSchema);
    const res = await providerFetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxOutputTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        tools: [
          {
            name: RESPOND_TOOL,
            description: 'Return the final answer as structured JSON.',
            input_schema: schema,
          },
        ],
        tool_choice: { type: 'tool', name: RESPOND_TOOL },
      }),
      signal: req.signal,
    });
    if (!res.ok) throw classifyProviderError(await readProviderError(res));

    const body = await readJson<AnthropicResponse>(res);
    const content = body.content ?? [];
    const toolUse = content.find(
      (block) => block.type === 'tool_use' && block.name === RESPOND_TOOL,
    );
    let text: string;
    if (toolUse) {
      const input = toolUse.input as Record<string, unknown> | undefined;
      text = JSON.stringify(wrapped ? input?.value : input) ?? '';
    } else {
      // Model không gọi tool (hiếm): trả văn bản để LlmService thử parse/validate.
      text = content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
    }
    return {
      text,
      inputTokens: body.usage?.input_tokens ?? null,
      outputTokens: body.usage?.output_tokens ?? null,
    };
  }
}
