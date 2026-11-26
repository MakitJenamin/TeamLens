import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/utils";

vi.mock("server-only", () => ({}));
const incoming = { current: new Headers() };
vi.mock("next/headers", () => ({
  headers: async () => incoming.current,
  cookies: async () => ({ get: () => undefined }),
}));

const { clientIpFrom, fetchInvitePreview } = await import("./server");

const CODE = "Zm9vYmFyYmF6cXV4";
const PREVIEW = {
  serverUrl: "http://localhost:3000/",
  project: { id: "p1", name: "Đội Web", slug: "doi-web" },
  repoPatterns: [],
  consent: { version: "v", text: "..." },
  expiresAt: "2026-12-04T03:00:00Z",
};

describe("clientIpFrom", () => {
  it("lấy phần tử cuối của x-forwarded-for (do proxy gần nhất ghi)", () => {
    expect(clientIpFrom(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }))).toBe(
      "203.0.113.7",
    );
    expect(clientIpFrom(new Headers({ "x-forwarded-for": " 198.51.100.2 " }))).toBe(
      "198.51.100.2",
    );
  });

  it("dùng x-real-ip khi không có x-forwarded-for, trả null khi không có gì", () => {
    expect(clientIpFrom(new Headers({ "x-real-ip": "198.51.100.9" }))).toBe("198.51.100.9");
    expect(clientIpFrom(new Headers())).toBeNull();
  });
});

describe("fetchInvitePreview", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(PREVIEW));
  });
  afterEach(() => fetchMock.mockRestore());

  function forwardedHeader(call: number): string | undefined {
    const init = fetchMock.mock.calls[call][1] as RequestInit;
    return (init.headers as Record<string, string>)["X-Forwarded-For"];
  }

  it("chuyển IP của từng người xem sang API qua X-Forwarded-For", async () => {
    incoming.current = new Headers({ "x-forwarded-for": "203.0.113.7" });
    await expect(fetchInvitePreview(CODE)).resolves.toEqual({ ok: true, preview: PREVIEW });
    incoming.current = new Headers({ "x-forwarded-for": "198.51.100.2" });
    await fetchInvitePreview(CODE);

    expect(String(fetchMock.mock.calls[0][0])).toContain(`/agent/v1/invites/${CODE}`);
    expect(forwardedHeader(0)).toBe("203.0.113.7");
    expect(forwardedHeader(1)).toBe("198.51.100.2");
  });

  it("không gửi X-Forwarded-For khi không biết IP người xem", async () => {
    incoming.current = new Headers();
    await fetchInvitePreview(CODE);
    expect(forwardedHeader(0)).toBeUndefined();
  });
});
