# Module `llm` — lõi gọi LLM (M6.1)

Mọi tính năng AI (Người 1, 2, 3) gọi LLM **chỉ** qua `LlmService` của module này, bằng API key của chính người bấm (BYO, không có key chung của server). Thiết kế: [docs/AI_PLAN.md](../../../../../docs/AI_PLAN.md).

| File | Nội dung |
| --- | --- |
| `llm.module.ts` | `LlmModule`, export `LlmService`, `LlmKeyService`. |
| `llm.service.ts` | `run`, `testKey`, `findResults`, `hasKey`; `toAiResult` (bản ghi → `AiResult` của contract), `toJsonSchema`. |
| `llm-key.service.ts` | Key BYO ở `user_llm_keys`: `getKeyInfo`, `saveKey`, `deleteKey`, `hasKey`, `resolveTestConfig`, nội bộ `getDecryptedKey`. |
| `llm.types.ts` | `LlmTask<T>`, `AiResultRow<T>`, `LlmKeyConfig`, `AiLocale`... |
| `llm-errors.ts` | `llmError(code)` tạo `ApiError` cho 7 mã lỗi LLM, `llmErrorCode(error)`. |
| `prompt.ts` | Câu chặn injection `UNTRUSTED_DATA_GUARD`, bọc `<untrusted_data>` có escape, yêu cầu ngôn ngữ theo locale, parse JSON (bóc ```json). |
| `key-crypto.ts` | AES-256-GCM bằng `TEAMLENS_SECRET_KEY`, IV 12 byte; lưu dạng `v1.<iv>.<ciphertext>.<tag>` (base64). |
| `adapters/` | `LlmAdapter`, token DI `LLM_ADAPTERS` (map provider → adapter), `FakeLlmAdapter`, adapter Anthropic và OpenAI-compatible. |

## Dùng trong một tính năng

```ts
// my-feature.module.ts
@Module({ imports: [LlmModule], providers: [MyFeatureService] })
export class MyFeatureModule {}

// my-feature.service.ts
import { z } from 'zod';
import { LlmService, toAiResult } from '../llm/llm.service.js';

const SummarySchema = z.object({
  title: z.string(),
  summary: z.string(),
  keyTurns: z.array(z.object({ seq: z.number().int(), note: z.string() })),
});

@Injectable()
export class MyFeatureService {
  constructor(private readonly llm: LlmService) {}

  async summarize(user: AuthUser, sessionId: string, locale: 'vi' | 'en') {
    // 1. Kiểm tra quyền xem dữ liệu như endpoint thường (AccessService + audit) TRƯỚC khi gọi.
    // 2. Lấy dữ liệu, đã che secret, cắt gọn (AI_PLAN mục 3).
    const row = await this.llm.run(user.id, {
      kind: 'session_summary',
      subjectType: 'session',
      subjectId: sessionId,
      subjectUserId: session.userId, // chủ dữ liệu
      locale,
      promptVersion: 'session_summary@1', // đổi prompt thì tăng số
      system: 'You summarize an AI coding session for its owner...', // không chứa dữ liệu người dùng
      untrusted: turns.map((t) => ({ label: `turn ${t.seq}`, content: t.text })),
      schema: SummarySchema,
      maxOutputTokens: 1500, // mặc định 2048
    });
    return toAiResult(row); // dạng `AiResult` của contract; row.result đã có kiểu z.infer<typeof SummarySchema>
  }
}
```

`run` làm theo thứ tự: lấy key đã giải mã của `userId` (không có → `llm_key_missing`) → chuyển `schema` sang JSON Schema (`z.toJSONSchema`) → ghép prompt (system = câu chặn + `system` + yêu cầu ngôn ngữ + schema; user = các khối `untrusted` bọc `<untrusted_data label="…">`) → gọi adapter (timeout 60 giây) → parse JSON, validate zod; sai thì gọi lại 1 lần, vẫn sai → `llm_bad_output` → upsert `ai_results` theo unique `(user_id, kind, subject_type, subject_id, locale)` (ghi đè, `created_at` = now, số token cộng cả lần thử lại) → trả bản ghi.

Đọc lại kết quả của chính người gọi: `llm.findResults(user.id, { subjectType: 'session', subjectIds: [id], kind?, locale? })`.

Không log prompt, key hay nội dung kết quả; service chỉ log kind, model, số token, số lần thử, thời gian.

## Key BYO (`LlmKeyService`, dùng cho trang "Cài đặt AI")

- `getKeyInfo(userId)` → `LlmKey | null` (contract; `keyHint` dạng `…a1B2`, key ngắn dưới 8 ký tự thì rỗng). Không bao giờ trả key.
- `saveKey(userId, { provider, baseUrl?, model, apiKey? })` → `LlmKey`. `apiKey` bỏ trống khi đã có key = giữ key cũ; chưa có key mà thiếu → 400 `validation_error`. `openai_compatible` bắt buộc `baseUrl` (400), cho phép `apiKey: ''` (Ollama không cần key). `anthropic` để `baseUrl` null = `https://api.anthropic.com`.
- `deleteKey(userId)`.
- `resolveTestConfig(userId, partial)` → cấu hình đầy đủ cho `POST /me/llm-key/test` (trường thiếu lấy từ key đã lưu), rồi truyền cho `LlmService.testKey(cfg)` → `{ latencyMs }`.

## Mã lỗi

Ném bằng `llmError(code)`; filter lỗi chung trả `{ error, message }`.

| HTTP | `error` | Khi nào |
| --- | --- | --- |
| 409 | `llm_key_missing` | Người gọi chưa nhập key (hoặc key đã lưu không giải mã được) |
| 422 | `llm_key_invalid` | Provider báo key sai (401/403) |
| 429 | `llm_quota_exceeded` | Hết quota / rate limit (429, `insufficient_quota`) |
| 422 | `llm_model_not_found` | Model không tồn tại (404 / `model_not_found`) |
| 504 | `llm_timeout` | Quá 60 giây |
| 502 | `llm_provider_error` | Lỗi khác từ provider / không kết nối được |
| 502 | `llm_bad_output` | Đầu ra không đúng JSON schema sau 1 lần thử lại |

## Test bằng `FakeLlmAdapter`

Unit test: tạo thẳng `new LlmService(db, keys, fakeAdapters(fake), timeoutMs)` (xem `llm.service.spec.ts`), hoặc mock `LlmService.run` bằng `vi.fn()`.

e2e: override token `LLM_ADAPTERS` (xem `test/llm.e2e-spec.ts`):

```ts
import { LLM_ADAPTERS } from '../src/modules/llm/adapters/adapter.js';
import { FAKE_HANG, FakeLlmAdapter, fakeAdapters } from '../src/modules/llm/adapters/fake.adapter.js';
import { llmError } from '../src/modules/llm/llm-errors.js';

const fake = new FakeLlmAdapter();
const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(LLM_ADAPTERS)
  .useValue(fakeAdapters(fake))
  .compile();

fake.enqueue({ title: 'ok' });              // object → JSON.stringify
fake.enqueue('không phải JSON');            // chuỗi trả nguyên văn (thử llm_bad_output: xếp 2 lần)
fake.enqueue(llmError('llm_quota_exceeded')); // ném lỗi
fake.enqueue(FAKE_HANG);                    // treo tới khi bị hủy (thử timeout)
fake.calls;                                  // các request đã nhận (system, user, jsonSchema...)
```

Người dùng trong test phải có key: `app.get(LlmKeyService).saveKey(userId, { provider: 'anthropic', model: 'm', apiKey: 'sk-test-0000' })`.
