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
export type MemberStatus = Schemas['MemberStatus'];
export type MemberStatusList = Schemas['MemberStatusList'];

// Session trên dashboard (REST, camelCase).
export type AgentKind = Schemas['AgentKind'];
export type PermissionMode = Schemas['PermissionMode'];
export type TokenUsage = Schemas['TokenUsage'];
export type SessionSummary = Schemas['SessionSummary'];
export type SessionPage = Schemas['SessionPage'];
export type SessionSearchMatch = Schemas['SessionSearchMatch'];
export type SessionDetail = Schemas['SessionDetail'];
export type SessionTurn = Schemas['SessionTurn'];
export type SessionChild = Schemas['SessionChild'];
export type SessionNote = Schemas['SessionNote'];
export type SessionNoteList = Schemas['SessionNoteList'];
export type CreateSessionNoteRequest = Schemas['CreateSessionNoteRequest'];
export type InstructionFile = Schemas['InstructionFile'];

// AI (Mốc 6, ai.yaml) và token cho agent (agent-tokens.yaml).
export type LlmProvider = Schemas['LlmProvider'];
export type LlmKey = Schemas['LlmKey'];
export type PutLlmKeyRequest = Schemas['PutLlmKeyRequest'];
export type TestLlmKeyRequest = Schemas['TestLlmKeyRequest'];
export type LlmKeyTestResult = Schemas['LlmKeyTestResult'];
export type AiLocale = Schemas['AiLocale'];
export type AiKind = Schemas['AiKind'];
export type AiSubjectType = Schemas['AiSubjectType'];
export type AiResult = Schemas['AiResult'];
export type SessionAiResults = Schemas['SessionAiResults'];
export type RunAiRequest = Schemas['RunAiRequest'];
export type AiTurnRef = Schemas['AiTurnRef'];
export type SessionWorkType = Schemas['SessionWorkType'];
export type SessionSummaryResult = Schemas['SessionSummaryResult'];
export type SessionOutcomeResult = Schemas['SessionOutcomeResult'];
export type FindingExplainResult = Schemas['FindingExplainResult'];
export type AgentToken = Schemas['AgentToken'];
export type CreateAgentTokenRequest = Schemas['CreateAgentTokenRequest'];
export type CreatedAgentToken = Schemas['CreatedAgentToken'];

// Payload ingest của CLI (session.v1.schema.json, snake_case). Tên gốc trong `Schemas` là
// `Session`, `Turn`... nên export lại với tiền tố `Ingest` cho rõ.
export type IngestBatch = Schemas['IngestBatch'];
export type IngestSessionEnvelope = Schemas['SessionEnvelope'];
export type IngestSession = Schemas['Session'];
export type IngestTurn = Schemas['Turn'];
export type IngestTool = Schemas['Tool'];
export type IngestOutput = Schemas['Output'];
export type IngestDiff = Schemas['Diff'];
export type IngestUsage = Schemas['Usage'];
export type IngestAttachment = Schemas['Attachment'];
export type IngestRedaction = Schemas['Redaction'];
export type IngestResult = Schemas['IngestResult'];
export type IngestRejectedCode = Schemas['IngestRejected']['error'];
export type AgentConfig = Schemas['AgentConfig'];
export type HeartbeatRequest = Schemas['HeartbeatRequest'];
export type HeartbeatResult = Schemas['HeartbeatResult'];

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
/** Kết quả `GET /agent/v1/whoami`. */
export type WhoamiResponse = ResponseBody<'agentWhoami', 200>;
/** Query của `GET /api/v1/projects/{projectId}/sessions`. */
export type ListProjectSessionsQuery = NonNullable<operations['listProjectSessions']['parameters']['query']>;
