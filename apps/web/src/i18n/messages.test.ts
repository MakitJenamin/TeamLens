import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { loadMessages } = await import("./messages");

function keyPaths(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe("loadMessages", () => {
  it("gộp mỗi file thành một namespace", async () => {
    const vi_ = await loadMessages("vi");
    for (const ns of [
      "common",
      "auth",
      "nav",
      "sessions",
      "overview",
      "members",
      "leaderboard",
      "rules",
      "admin",
      "me",
      "invite",
    ]) {
      expect(vi_).toHaveProperty(ns);
    }
  });

  it("vi và en có cùng bộ khóa", async () => {
    const [viMessages, enMessages] = await Promise.all([loadMessages("vi"), loadMessages("en")]);
    expect(keyPaths(enMessages).sort()).toEqual(keyPaths(viMessages).sort());
  });
});
