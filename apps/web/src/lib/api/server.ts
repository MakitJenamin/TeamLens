import "server-only";
import { cookies } from "next/headers";
import { ApiError, apiPath, parseResponse } from "./client";
import { SESSION_COOKIE } from "@/lib/auth-paths";

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
