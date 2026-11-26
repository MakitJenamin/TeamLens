import "server-only";
import { cookies } from "next/headers";
import { ApiError, apiPath, parseResponse } from "./client";
import { SESSION_COOKIE } from "@/lib/auth-paths";
import type { InvitePreview } from "./types";

function apiInternalUrl(): string {
  return process.env.API_INTERNAL_URL ?? "http://localhost:3001";
}

/**
 * Gọi API từ server component qua API_INTERNAL_URL,
 * chuyển tiếp cookie `tl_session` của người dùng.
 */
export async function serverApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE)?.value;

  let res: Response;
  try {
    res = await fetch(`${apiInternalUrl()}${apiPath(path)}`, {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(session ? { Cookie: `${SESSION_COOKIE}=${session}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, "network_error", "Không kết nối được tới API");
  }
  return parseResponse<T>(res);
}

/** Như serverApi nhưng trả null khi chưa đăng nhập (401). */
export async function serverApiOrNull<T>(path: string): Promise<T | null> {
  try {
    return await serverApi<T>(path);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** Trạng thái setup; trả null nếu không gọi được API (để trang vẫn hiển thị). */
export async function fetchNeedsSetup(): Promise<boolean | null> {
  try {
    const status = await serverApi<{ needsSetup: boolean }>("/setup/status");
    return status.needsSetup;
  } catch {
    return null;
  }
}

/** Mã mời hợp lệ theo contract (`InviteCode`): chặn ký tự lạ trước khi ghép vào URL. */
const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;

export type InvitePreviewResult =
  | { ok: true; preview: InvitePreview }
  | { ok: false; error: string };

/**
 * Xem trước link mời (`GET /agent/v1/invites/{code}`, công khai) cho trang `/i/<mã>`.
 * Không ném lỗi: trả mã lỗi máy đọc để trang hiện thông báo phù hợp.
 */
export async function fetchInvitePreview(code: string): Promise<InvitePreviewResult> {
  if (!INVITE_CODE_PATTERN.test(code)) return { ok: false, error: "invite_not_found" };
  let res: Response;
  try {
    res = await fetch(`${apiInternalUrl()}/agent/v1/invites/${encodeURIComponent(code)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    return { ok: false, error: "network_error" };
  }
  try {
    return { ok: true, preview: await parseResponse<InvitePreview>(res) };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.code : "http_error" };
  }
}
