// TODO(F2): chuyển sang type sinh từ @teamlens/schema khi gộp
// Kiểu viết tay theo contract giai đoạn nền (REST dashboard, camelCase).
// Mọi id là UUID (string). Mật khẩu tối thiểu 8 ký tự.

/** Mã lỗi máy đọc được trong body { error, message }. */
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
  | "expired_code";

export const PASSWORD_MIN_LENGTH = 8;

export type Role = "leader" | "member";

export interface User {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}

// --- Setup & auth ---
export interface SetupStatus {
  needsSetup: boolean;
}

export interface SetupRequest {
  email: string;
  name: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface UserResponse {
  user: User;
}

export interface Membership {
  projectId: string;
  projectName: string;
  projectSlug: string;
  role: Role;
}

export interface MeResponse {
  user: User;
  memberships: Membership[];
}

// --- Projects ---
export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  /** null khi admin không phải thành viên của project */
  role: Role | null;
}

export interface Repo {
  id: string;
  remotePattern: string;
}

/** Trả về từ POST/PATCH project (không kèm repos). */
export interface Project {
  id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
}

/** Trả về từ GET /projects/:projectId (kèm repos). */
export interface ProjectDetail extends Project {
  repos: Repo[];
}

export interface CreateProjectRequest {
  name: string;
  slug: string;
}

export interface UpdateProjectRequest {
  name?: string;
  settings?: Record<string, unknown>;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
}

export interface AddMemberRequest {
  email: string;
  role: Role;
}

export interface UpdateMemberRequest {
  role: Role;
}

export interface CreateRepoRequest {
  remotePattern: string;
}

// --- Users (admin) ---
export interface CreateUserRequest {
  email: string;
  name: string;
  password: string;
  isAdmin?: boolean;
}

// --- Devices ---
export interface DeviceApproveRequest {
  userCode: string;
}

export interface DeviceApproveResponse {
  device: { id: string; name: string };
}

export type DeviceStatus = "online" | "offline" | "paused" | "consent_revoked";

export interface Device {
  id: string;
  name: string;
  os: string;
  cliVersion: string;
  status: DeviceStatus;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}
