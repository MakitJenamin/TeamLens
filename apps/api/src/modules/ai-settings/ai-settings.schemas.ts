import { z } from 'zod';

const provider = z.enum(['anthropic', 'openai_compatible']);

/** `baseUrl`: chỉ http(s); null hoặc bỏ trống = mặc định của provider (bắt buộc với `openai_compatible`, kiểm ở service). */
const baseUrl = z
  .union([
    z.url({
      protocol: /^https?$/,
      error: 'baseUrl phải là địa chỉ http(s), ví dụ http://localhost:11434/v1',
    }),
    z.null(),
  ])
  .optional();

/**
 * `apiKey` cho phép chuỗi rỗng (lệch nhẹ so với `minLength: 1` của contract): Ollama và nhiều server
 * OpenAI-compatible tự host không cần key. `LlmKeyService` chỉ nhận chuỗi rỗng với `openai_compatible`.
 */
const apiKey = z.string().max(1000, 'API key quá dài').optional();

const model = z.string().trim().min(1, 'Cần nhập tên model').max(200);

export const putLlmKeySchema = z.strictObject({
  provider,
  baseUrl,
  model,
  apiKey,
});

export const testLlmKeySchema = z
  .strictObject({
    provider: provider.optional(),
    baseUrl,
    model: model.optional(),
    apiKey,
  })
  // Body rỗng = kiểm tra key đang lưu.
  .optional()
  .transform((value) => value ?? {});

export const createAgentTokenSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, 'Tên token không được để trống')
    .max(100, 'Tên token tối đa 100 ký tự'),
});
