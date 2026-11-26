// Kiểu dữ liệu API của dashboard, lấy từ contract OpenAPI (@teamlens/schema).
// Không viết tay kiểu mới ở đây: sửa contract trong packages/schema rồi sinh lại type.
// Các alias giữ tên cũ để code web không phụ thuộc trực tiếp vào cấu trúc file sinh ra.
import type { operations, RequestBody, ResponseBody, Schemas } from "@teamlens/schema";

/** Mã lỗi máy đọc được trong body { error, message } (theo các response của contract). */
export type ApiErrorCode =
  | "validation_error"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_credentials"
  | "already_setup"
  | "email_taken"
  | "slug_taken"
  | "already_member"
  | "user_not_found"
  | "invalid_pattern"
  | "invalid_code"
  | "expired_code"
  | "invite_not_found"
  | "invite_expired"
  | "invite_used_up"
  | "invite_revoked"
  | "invalid_ticket"
  | "rate_limited";

/** Độ dài mật khẩu tối thiểu (minLength trong setup.yaml, users.yaml). */
export const PASSWORD_MIN_LENGTH = 8;

// --- Schema có tên ---
export type ApiErrorBody = Schemas["Error"];
export type Role = Schemas["Role"];
export type User = Schemas["User"];
export type Membership = Schemas["Membership"];
export type ProjectSettings = Schemas["ProjectSettings"];
/** Một dòng của `GET /projects` (`role` = null khi admin không là thành viên). */
export type ProjectSummary = Schemas["ProjectListItem"];
/** Trả về từ POST/PATCH project (không kèm repos). */
export type Project = Schemas["Project"];
/** Trả về từ GET /projects/:projectId (kèm repos). */
export type ProjectDetail = Schemas["ProjectDetail"];
export type Repo = Schemas["Repo"];
export type Member = Schemas["Member"];
export type DeviceStatus = Schemas["DeviceStatus"];
export type Device = Schemas["Device"];

// --- Body request / response theo operationId ---
export type SetupStatus = ResponseBody<"getSetupStatus", 200>;
export type SetupRequest = RequestBody<"setup">;
/** Kết quả wizard /setup: có `project` và `invite` khi gửi kèm project. */
export type SetupResponse = ResponseBody<"setup", 201>;
export type LoginRequest = RequestBody<"login">;
export type UserResponse = ResponseBody<"login", 200>;
export type MeResponse = ResponseBody<"getMe", 200>;

export type CreateProjectRequest = RequestBody<"createProject">;
export type UpdateProjectRequest = RequestBody<"updateProject">;
export type AddMemberRequest = RequestBody<"addProjectMember">;
export type CreateRepoRequest = RequestBody<"addProjectRepo">;
export type CreateLeaderRequest = RequestBody<"createLeader">;
export type UpdateUserRoleRequest = RequestBody<"updateUserRole">;

// --- Session (M1.8) ---
export type AgentKind = Schemas["AgentKind"];
export type PermissionMode = Schemas["PermissionMode"];
export type InstructionFile = Schemas["InstructionFile"];
export type SessionSummary = Schemas["SessionSummary"];
export type SessionPage = ResponseBody<"listProjectSessions", 200>;
export type SessionDetail = ResponseBody<"getSession", 200>;
export type SessionTurn = Schemas["SessionTurn"];
export type ListProjectSessionsQuery = NonNullable<operations["listProjectSessions"]["parameters"]["query"]>;

// --- Link mời, tl open (Mốc 1.5) ---
export type InviteStatus = Schemas["InviteStatus"];
export type Invite = Schemas["Invite"];
/** Link vừa tạo: `code`, `url`, `installCommand` chỉ trả đúng một lần. */
export type CreatedInvite = Schemas["CreatedInvite"];
export type CreateInviteRequest = NonNullable<RequestBody<"createProjectInvite">>;
export type InvitePreview = Schemas["InvitePreview"];
export type ExchangeTicketRequest = RequestBody<"exchangeLoginTicket">;
export type ExchangeTicketResponse = ResponseBody<"exchangeLoginTicket", 200>;
