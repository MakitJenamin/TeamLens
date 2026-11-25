// Điểm vào của @teamlens/schema: type sinh từ OpenAPI và các kiểu tiện dụng cho API, web.
// File src/generated/api.ts do `pnpm --filter @teamlens/schema generate` sinh ra, không sửa tay.
import type { components, operations, paths } from './generated/api.js';

export type { components, operations, paths };

/** Mọi schema có tên trong contract. */
export type Schemas = components['schemas'];

export type ApiError = Schemas['Error'];
export type Role = Schemas['Role'];
export type User = Schemas['User'];
export type UserRef = Schemas['UserRef'];
export type Membership = Schemas['Membership'];
export type ProjectSettings = Schemas['ProjectSettings'];
export type ProjectListItem = Schemas['ProjectListItem'];
export type Project = Schemas['Project'];
export type ProjectDetail = Schemas['ProjectDetail'];
export type Repo = Schemas['Repo'];
export type Member = Schemas['Member'];
export type DeviceStatus = Schemas['DeviceStatus'];
export type DeviceRef = Schemas['DeviceRef'];
export type Device = Schemas['Device'];

type JsonContent<T> = T extends { content: { 'application/json': infer B } } ? B : never;

/** Body JSON của request theo operationId, vd. `RequestBody<'login'>`. */
export type RequestBody<Op extends keyof operations> = operations[Op] extends {
  requestBody?: infer R;
}
  ? JsonContent<NonNullable<R>>
  : never;

/** Body JSON của response theo operationId và mã HTTP, vd. `ResponseBody<'getMe', 200>`. */
export type ResponseBody<
  Op extends keyof operations,
  Status extends keyof operations[Op]['responses'],
> = JsonContent<operations[Op]['responses'][Status]>;

/** Kết quả `GET /api/v1/auth/me`. */
export type MeResponse = ResponseBody<'getMe', 200>;
/** Kết quả `POST /agent/v1/device/code`. */
export type DeviceCodeResponse = ResponseBody<'agentDeviceCode', 200>;
/** Kết quả `GET /agent/v1/whoami`. */
export type WhoamiResponse = ResponseBody<'agentWhoami', 200>;
/** Mã lỗi khi poll `POST /agent/v1/device/token`. */
export type DeviceTokenErrorCode = ResponseBody<'agentDeviceToken', 400>['error'];
