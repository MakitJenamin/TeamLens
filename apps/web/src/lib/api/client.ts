import type { ApiErrorBody } from "./types";

/** Lỗi từ API theo dạng { error, message }. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ApiErrorBody).error === "string"
  );
}

/** Đọc body JSON (nếu có) và ném ApiError khi status không thành công. */
export async function parseResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }

  if (!res.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiError(res.status, body.error, body.message ?? body.error);
    }
    throw new ApiError(res.status, "http_error", `Lỗi HTTP ${res.status}`);
  }
  return body as T;
}

type JsonBody = object;

export interface ApiRequestInit extends Omit<RequestInit, "body"> {
  body?: JsonBody;
}

/** Ghép path dạng "/auth/me" thành "/api/v1/auth/me". */
export function apiPath(path: string): string {
  return `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Gọi API dashboard từ trình duyệt (cùng origin, Next rewrite sang API).
 * Cookie `tl_session` được gửi kèm tự động.
 */
export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { body, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(apiPath(path), {
      credentials: "include",
      ...rest,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network_error", "Không kết nối được tới máy chủ");
  }
  return parseResponse<T>(res);
}

export const api = {
  get: <T>(path: string, init?: ApiRequestInit) => apiFetch<T>(path, { ...init, method: "GET" }),
  post: <T>(path: string, body?: JsonBody, init?: ApiRequestInit) =>
    apiFetch<T>(path, { ...init, method: "POST", body }),
  patch: <T>(path: string, body?: JsonBody, init?: ApiRequestInit) =>
    apiFetch<T>(path, { ...init, method: "PATCH", body }),
  delete: <T>(path: string, init?: ApiRequestInit) =>
    apiFetch<T>(path, { ...init, method: "DELETE" }),
};
