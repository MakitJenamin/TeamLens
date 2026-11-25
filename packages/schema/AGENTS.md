# packages/schema — contract của TeamLens

Nguồn chân lý cho API (`apps/api`), web (`apps/web`) và CLI (`cli/`). Đổi contract trước, code sau, trong PR riêng chỉ sửa thư mục này.

## Cấu trúc

| Đường dẫn | Nội dung |
| --- | --- |
| `openapi/openapi.yaml` | File gốc OpenAPI 3.1: info, server, security scheme (`cookieAuth`, `deviceToken`), tag, `$ref` tới từng path |
| `openapi/common.yaml` | Schema, response lỗi, tham số, header dùng chung (`Error`, `User`, `Project`, ...) |
| `openapi/<nhóm>.yaml` | Mỗi nhóm endpoint một file: `health`, `setup`, `auth`, `projects`, `users`, `devices`, `agent-auth` (đã viết); `agent`, `sessions`, `invites`, `consent`, `rules`, `stats`, `admin` (khung, vùng sở hữu ghi ở đầu file) |
| `session.v1.schema.json` | JSON Schema draft 2020-12 cho batch ingest (`IngestBatch` → `SessionEnvelope` → `Session`, `Turn`), snake_case |
| `examples/*.json` | Batch mẫu hợp lệ (dữ liệu giả); CLI và API dùng để test |
| `src/index.ts` | Export `paths`, `components`, `operations` và kiểu tiện dụng (`User`, `RequestBody<'login'>`, `ResponseBody<'getMe', 200>`...) |
| `src/generated/api.ts` | Sinh bởi `openapi-typescript`, **không sửa tay**, có commit |
| `dist/openapi.yaml` | Bản gộp (không commit), export qua `@teamlens/schema/openapi.yaml` |

## Lệnh

```bash
pnpm --filter @teamlens/schema build        # lint + bundle ra dist/openapi.yaml, rồi sinh src/generated/api.ts
pnpm --filter @teamlens/schema lint         # redocly lint (cấu hình redocly.yaml)
pnpm --filter @teamlens/schema test         # kiểm tra examples/ khớp session.v1.schema.json + ca phải bị từ chối
pnpm --filter @teamlens/schema typecheck    # tsc --noEmit
```

## Sửa contract

1. **Thêm hoặc sửa endpoint:** viết path item trong file nhóm (path đầy đủ, vd. `/api/v1/sessions`). Nếu path mới, thêm một dòng vào `paths:` của `openapi/openapi.yaml`:
   `$ref: './sessions.yaml#/paths/~1api~1v1~1sessions'` (`/` trong path viết thành `~1`).
2. **Schema dùng chung:** thêm vào `openapi/common.yaml` và đăng ký lại dưới `components.schemas` của file gốc để type sinh ra có tên (`components['schemas']['Xyz']`).
3. Mọi operation phải có `operationId`, `tags`, `security` (`[]` nếu công khai) và lỗi theo `Error { error, message }`; ghi mã `error` trong `description` và `example`.
4. REST API dùng camelCase; payload session ingest dùng snake_case theo `session.v1.schema.json`.
5. Chạy `build`, kiểm tra diff của `src/generated/api.ts`, commit cùng thay đổi YAML (CI báo lỗi nếu file sinh ra chưa cập nhật).

## Sửa schema session

- Thay đổi tương thích ngược (thêm trường tùy chọn): sửa `session.v1.schema.json`, thêm hoặc sửa file trong `examples/`, chạy `test`. Struct `serde` của CLI (`tl-core`) phải cập nhật theo.
- Thay đổi phá vỡ: tạo `session.v2.schema.json`, không sửa v1 (server trả `426` cho CLI cũ).
- Schema chặt (`additionalProperties: false`) ở mọi chỗ trừ `tool.input`. Ca phải bị từ chối nằm trong `scripts/validate-examples.mjs`; thêm ca khi thêm ràng buộc.
- Dữ liệu trong `examples/` phải là dữ liệu giả: không secret, không đường dẫn cá nhân, không tên máy.
