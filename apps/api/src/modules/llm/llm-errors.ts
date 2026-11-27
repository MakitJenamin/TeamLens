import { ApiError } from '../../common/api-error.js';

/**
 * Mã lỗi LLM dùng chung mọi nút AI (contract `openapi/ai.yaml`).
 * Adapter ném đúng các lỗi này; `LlmService` bọc mọi lỗi lạ thành `llm_provider_error`.
 */
export const LLM_ERROR_STATUS = {
  llm_key_missing: 409,
  llm_key_invalid: 422,
  llm_quota_exceeded: 429,
  llm_model_not_found: 422,
  llm_timeout: 504,
  llm_provider_error: 502,
  llm_bad_output: 502,
} as const;

export type LlmErrorCode = keyof typeof LLM_ERROR_STATUS;

const DEFAULT_MESSAGES: Record<LlmErrorCode, string> = {
  llm_key_missing:
    'Bạn chưa nhập API key AI. Vào "Cài đặt AI" để nhập key của bạn.',
  llm_key_invalid: 'Nhà cung cấp AI báo API key không hợp lệ',
  llm_quota_exceeded:
    'Nhà cung cấp AI báo đã hết quota hoặc gọi quá nhanh, thử lại sau',
  llm_model_not_found: 'Nhà cung cấp AI báo không có model này',
  llm_timeout: 'Nhà cung cấp AI không trả lời kịp thời gian chờ',
  llm_provider_error: 'Lỗi khi gọi nhà cung cấp AI',
  llm_bad_output: 'AI trả kết quả không đúng định dạng, thử lại sau',
};

/** Tạo `ApiError` cho một mã lỗi LLM, đúng HTTP status của contract. */
export function llmError(code: LlmErrorCode, message?: string): ApiError {
  return new ApiError(
    LLM_ERROR_STATUS[code],
    code,
    message ?? DEFAULT_MESSAGES[code],
  );
}

/** Mã lỗi LLM của một lỗi bất kỳ, hoặc null nếu không phải lỗi LLM. */
export function llmErrorCode(error: unknown): LlmErrorCode | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.getResponse() as { error?: string };
  return body.error && body.error in LLM_ERROR_STATUS
    ? (body.error as LlmErrorCode)
    : null;
}
