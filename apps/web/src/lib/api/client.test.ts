import { describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/utils";
import { ApiError, api, apiPath } from "./client";

describe("apiPath", () => {
  it("thêm prefix /api/v1", () => {
    expect(apiPath("/auth/me")).toBe("/api/v1/auth/me");
    expect(apiPath("projects")).toBe("/api/v1/projects");
  });
});

describe("api client", () => {
  it("gửi JSON cùng origin kèm cookie và trả body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ user: { id: "u1" } }));

    const res = await api.post<{ user: { id: string } }>("/auth/login", {
      email: "a@b.c",
      password: "x",
    });

    expect(res.user.id).toBe("u1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/auth/login");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(init?.body).toBe(JSON.stringify({ email: "a@b.c", password: "x" }));
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("ném ApiError với mã và thông báo từ body { error, message }", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "invalid_credentials", message: "Sai mật khẩu" }, 401),
    );

    const err = await api.post("/auth/login", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: "invalid_credentials", message: "Sai mật khẩu" });
  });

  it("204 trả undefined", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.post("/auth/logout")).resolves.toBeUndefined();
  });

  it("lỗi không có body chuẩn vẫn thành ApiError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad gateway", { status: 502 }));
    await expect(api.get("/projects")).rejects.toMatchObject({ status: 502, code: "http_error" });
  });

  it("lỗi mạng thành network_error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(api.get("/projects")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });
});
