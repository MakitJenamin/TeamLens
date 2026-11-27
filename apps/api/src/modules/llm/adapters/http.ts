import type { ApiError } from '../../../common/api-error.js';
import { llmError } from '../llm-errors.js';

/** Phần lỗi provider trả về, đã rút gọn (không bao giờ ghi log). */
export interface ProviderErrorInfo {
  status: number;
  /** `error.code` / `error.type` của provider, viết thường. */
  codes: string[];
  message: string;
  raw: string;
}

const MAX_MESSAGE = 300;

/** Đọc thân lỗi HTTP của provider (JSON kiểu OpenAI/Anthropic/Ollama hoặc văn bản). */
export async function readProviderError(
  res: Response,
): Promise<ProviderErrorInfo> {
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    // Thân lỗi không đọc được: chỉ dựa vào status.
  }
  const codes: string[] = [];
  let message = '';
  try {
    const body = JSON.parse(raw) as {
      error?: { code?: unknown; type?: unknown; message?: unknown } | string;
      type?: unknown;
      message?: unknown;
    };
    const error = body.error;
    if (typeof error === 'string') {
      message = error;
    } else if (error && typeof error === 'object') {
      for (const value of [error.code, error.type]) {
        if (typeof value === 'string') codes.push(value.toLowerCase());
      }
      if (typeof error.message === 'string') message = error.message;
    }
    if (typeof body.message === 'string' && !message) message = body.message;
  } catch {
    message = raw;
  }
  return {
    status: res.status,
    codes,
    message: message.slice(0, MAX_MESSAGE),
    raw: raw.slice(0, 4000),
  };
}

/** Phân loại lỗi HTTP của provider thành mã lỗi LLM. */
export function classifyProviderError(info: ProviderErrorInfo): ApiError {
  const { status, codes } = info;
  const text = `${codes.join(' ')} ${info.message}`.toLowerCase();
  const detail = info.message ? `: ${info.message}` : ` (HTTP ${status})`;
  if (status === 401 || status === 403 || codes.includes('invalid_api_key')) {
    return llmError(
      'llm_key_invalid',
      `Nhà cung cấp AI từ chối API key${detail}`,
    );
  }
  if (
    status === 429 ||
    codes.includes('insufficient_quota') ||
    text.includes('insufficient_quota')
  ) {
    return llmError(
      'llm_quota_exceeded',
      `Nhà cung cấp AI báo hết quota hoặc gọi quá nhanh${detail}`,
    );
  }
  if (
    status === 404 ||
    codes.includes('model_not_found') ||
    /model[^.]*not (found|exist)|does not exist/.test(text)
  ) {
    return llmError(
      'llm_model_not_found',
      `Nhà cung cấp AI báo không có model này${detail}`,
    );
  }
  return llmError(
    'llm_provider_error',
    `Nhà cung cấp AI báo lỗi HTTP ${status}${info.message ? `: ${info.message}` : ''}`,
  );
}

/**
 * `fetch` có phân loại lỗi mạng: bị hủy (timeout) → `llm_timeout`, không kết nối được → `llm_provider_error`.
 * Không đổi response lỗi HTTP (người gọi tự đọc để quyết định fallback).
 */
export async function providerFetch(
  url: string,
  init: RequestInit & { signal: AbortSignal },
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    if (init.signal.aborted) throw llmError('llm_timeout');
    throw llmError(
      'llm_provider_error',
      `Không kết nối được tới nhà cung cấp AI (${new URL(url).host})`,
    );
  }
}

/** Đọc JSON thành công của provider; thân không phải JSON thì `llm_provider_error`. */
export async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw llmError(
      'llm_provider_error',
      'Nhà cung cấp AI trả dữ liệu không phải JSON',
    );
  }
}

/** Bỏ dấu `/` cuối của URL gốc. */
export function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Provider chỉ nhận schema gốc là object: schema khác bọc thành `{ value: <schema> }`.
 * Trả schema để gửi và hàm lấy lại giá trị gốc từ đầu ra.
 */
export function objectRootSchema(schema: Record<string, unknown>): {
  schema: Record<string, unknown>;
  wrapped: boolean;
} {
  if (schema.type === 'object') return { schema, wrapped: false };
  return {
    schema: {
      type: 'object',
      properties: { value: schema },
      required: ['value'],
      additionalProperties: false,
    },
    wrapped: true,
  };
}
