import type { ApiError } from '../../../common/api-error.js';
import type { LlmCompleteRequest } from './adapter.js';
import { AnthropicAdapter } from './anthropic.adapter.js';
import {
  isStrictCompatible,
  OpenAiCompatibleAdapter,
} from './openai-compatible.adapter.js';

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};

function request(over: Partial<LlmCompleteRequest> = {}): LlmCompleteRequest {
  return {
    baseUrl: null,
    model: 'm',
    apiKey: 'sk-test',
    system: 'sys',
    user: 'usr',
    jsonSchema: SCHEMA,
    maxOutputTokens: 100,
    signal: new AbortController().signal,
    ...over,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function sent(call = 0): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
} {
  const [url, init] = fetchMock.mock.calls[call];
  return {
    url: url as string,
    headers: init?.headers as Record<string, string>,
    body: JSON.parse(init?.body as string),
  };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return ((error as ApiError).getResponse() as { error: string }).error;
  }
  throw new Error('không ném lỗi');
}

describe('AnthropicAdapter', () => {
  const adapter = new AnthropicAdapter();

  it('gọi /v1/messages với tool bắt buộc và đọc tool_use + usage', async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        content: [
          { type: 'text', text: 'ignored' },
          { type: 'tool_use', name: 'respond', input: { ok: true } },
        ],
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
    );
    const out = await adapter.complete(request());
    expect(out).toEqual({
      text: '{"ok":true}',
      inputTokens: 12,
      outputTokens: 3,
    });

    const { url, headers, body } = sent();
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(body).toMatchObject({
      model: 'm',
      max_tokens: 100,
      system: 'sys',
      messages: [{ role: 'user', content: 'usr' }],
      tools: [{ name: 'respond', input_schema: SCHEMA }],
      tool_choice: { type: 'tool', name: 'respond' },
    });
  });

  it('base tùy chỉnh có hoặc không có /v1', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        json(200, {
          content: [{ type: 'tool_use', name: 'respond', input: { ok: true } }],
        }),
      ),
    );
    await adapter.complete(request({ baseUrl: 'https://proxy.local/v1/' }));
    expect(sent(0).url).toBe('https://proxy.local/v1/messages');
    const out = await adapter.complete(
      request({ baseUrl: 'https://proxy.local' }),
    );
    expect(sent(1).url).toBe('https://proxy.local/v1/messages');
    expect(out.inputTokens).toBeNull();
  });

  it('schema gốc không phải object thì bọc { value } và bóc lại', async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        content: [
          { type: 'tool_use', name: 'respond', input: { value: [1, 2] } },
        ],
      }),
    );
    const out = await adapter.complete(
      request({ jsonSchema: { type: 'array', items: { type: 'number' } } }),
    );
    expect(out.text).toBe('[1,2]');
    expect(sent().body.tools[0].input_schema.properties.value.type).toBe(
      'array',
    );
  });

  it.each([
    [
      401,
      {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      },
      'llm_key_invalid',
    ],
    [
      403,
      { type: 'error', error: { type: 'permission_error', message: 'no' } },
      'llm_key_invalid',
    ],
    [
      429,
      {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'slow down' },
      },
      'llm_quota_exceeded',
    ],
    [
      404,
      {
        type: 'error',
        error: { type: 'not_found_error', message: 'model: x' },
      },
      'llm_model_not_found',
    ],
    [
      529,
      {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      },
      'llm_provider_error',
    ],
    [500, 'oops', 'llm_provider_error'],
  ])('HTTP %i → mã lỗi đúng', async (status, body, code) => {
    fetchMock.mockResolvedValue(
      typeof body === 'string'
        ? new Response(body, { status })
        : json(status, body),
    );
    expect(await errorCode(adapter.complete(request()))).toBe(code);
  });

  it('lỗi mạng → llm_provider_error, bị hủy → llm_timeout', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await errorCode(adapter.complete(request()))).toBe(
      'llm_provider_error',
    );
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    expect(
      await errorCode(adapter.complete(request({ signal: controller.signal }))),
    ).toBe('llm_timeout');
  });
});

describe('OpenAiCompatibleAdapter', () => {
  const adapter = new OpenAiCompatibleAdapter();
  const base = 'http://localhost:11434/v1/';

  function ok(content: string) {
    return json(200, {
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 20, completion_tokens: 4 },
    });
  }

  it('gọi /chat/completions với json_schema strict và đọc usage', async () => {
    fetchMock.mockResolvedValue(ok('{"ok":true}'));
    const out = await adapter.complete(request({ baseUrl: base }));
    expect(out).toEqual({
      text: '{"ok":true}',
      inputTokens: 20,
      outputTokens: 4,
    });
    const { url, headers, body } = sent();
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(body).toMatchObject({
      model: 'm',
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'respond', schema: SCHEMA, strict: true },
      },
    });
  });

  it('key rỗng thì không gửi Authorization', async () => {
    fetchMock.mockResolvedValue(ok('{"ok":true}'));
    await adapter.complete(request({ baseUrl: base, apiKey: '' }));
    expect(sent().headers).not.toHaveProperty('authorization');
  });

  it('server báo 400 về response_format thì thử lại bằng json_object', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(400, {
          error: {
            message:
              "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
            type: 'invalid_request_error',
          },
        }),
      )
      .mockResolvedValueOnce(ok('{"ok":false}'));
    const out = await adapter.complete(request({ baseUrl: base }));
    expect(out.text).toBe('{"ok":false}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1).body.response_format).toEqual({ type: 'json_object' });
  });

  it('model đòi max_completion_tokens thì thử lại', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(400, {
          error: {
            message:
              "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            code: 'unsupported_parameter',
          },
        }),
      )
      .mockResolvedValueOnce(ok('{"ok":true}'));
    await adapter.complete(request({ baseUrl: base }));
    expect(sent(1).body.max_completion_tokens).toBe(100);
    expect(sent(1).body).not.toHaveProperty('max_tokens');
  });

  it('schema có property tùy chọn thì strict false', () => {
    expect(isStrictCompatible(SCHEMA)).toBe(true);
    expect(
      isStrictCompatible({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      }),
    ).toBe(false);
    expect(
      isStrictCompatible({
        type: 'object',
        properties: {
          list: {
            type: 'array',
            items: {
              type: 'object',
              properties: { x: { type: 'number' } },
              required: ['x'],
            },
          },
        },
        required: ['list'],
        additionalProperties: false,
      }),
    ).toBe(false);
  });

  it.each([
    [
      401,
      {
        error: {
          message: 'Incorrect API key provided',
          code: 'invalid_api_key',
        },
      },
      'llm_key_invalid',
    ],
    [
      429,
      { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } },
      'llm_quota_exceeded',
    ],
    [
      400,
      {
        error: {
          message: 'You exceeded your current quota',
          type: 'insufficient_quota',
        },
      },
      'llm_quota_exceeded',
    ],
    [
      404,
      {
        error: {
          message: 'model "x" not found, try pulling it first',
          type: 'api_error',
        },
      },
      'llm_model_not_found',
    ],
    [
      400,
      {
        error: {
          message: 'The model `gpt-x` does not exist',
          code: 'model_not_found',
        },
      },
      'llm_model_not_found',
    ],
    [502, { error: 'bad gateway' }, 'llm_provider_error'],
    [503, 'down', 'llm_provider_error'],
  ])('HTTP %i → mã lỗi đúng', async (status, body, code) => {
    fetchMock.mockResolvedValue(
      typeof body === 'string'
        ? new Response(body, { status })
        : json(status, body),
    );
    expect(await errorCode(adapter.complete(request({ baseUrl: base })))).toBe(
      code,
    );
  });

  it('lỗi mạng → llm_provider_error, bị hủy → llm_timeout, thiếu baseUrl → llm_provider_error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await errorCode(adapter.complete(request({ baseUrl: base })))).toBe(
      'llm_provider_error',
    );
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    expect(
      await errorCode(
        adapter.complete(request({ baseUrl: base, signal: controller.signal })),
      ),
    ).toBe('llm_timeout');
    expect(await errorCode(adapter.complete(request()))).toBe(
      'llm_provider_error',
    );
  });

  it('schema gốc không phải object thì bọc { value } và bóc lại', async () => {
    fetchMock.mockResolvedValue(ok('{"value":["a"]}'));
    const out = await adapter.complete(
      request({
        baseUrl: base,
        jsonSchema: { type: 'array', items: { type: 'string' } },
      }),
    );
    expect(out.text).toBe('["a"]');
  });
});
