import { describe, expect, it } from "vitest";
import { isProtectedPath, localizePath, safeNextPath, splitLocale } from "./auth-paths";

describe("splitLocale", () => {
  it("tách prefix en", () => {
    expect(splitLocale("/en/login")).toEqual({ locale: "en", path: "/login" });
    expect(splitLocale("/en")).toEqual({ locale: "en", path: "/" });
  });
  it("không prefix là vi", () => {
    expect(splitLocale("/device")).toEqual({ locale: "vi", path: "/device" });
    expect(splitLocale("/")).toEqual({ locale: "vi", path: "/" });
  });
  it("prefix vi tường minh cũng nhận", () => {
    expect(splitLocale("/vi/me")).toEqual({ locale: "vi", path: "/me" });
  });
});

describe("isProtectedPath", () => {
  it("login và setup là công khai", () => {
    expect(isProtectedPath("/login")).toBe(false);
    expect(isProtectedPath("/setup")).toBe(false);
  });
  it("dashboard và device cần đăng nhập", () => {
    expect(isProtectedPath("/")).toBe(true);
    expect(isProtectedPath("/device")).toBe(true);
    expect(isProtectedPath("/me")).toBe(true);
    expect(isProtectedPath("/projects/abc/overview")).toBe(true);
    expect(isProtectedPath("/loginx")).toBe(true);
  });
});

describe("safeNextPath", () => {
  it("giữ đường dẫn nội bộ", () => {
    expect(safeNextPath("/device?code=ABCD-EFGH")).toBe("/device?code=ABCD-EFGH");
  });
  it("chặn open redirect", () => {
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("/\\evil.com")).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });
});

describe("localizePath", () => {
  it("vi không prefix, en có prefix", () => {
    expect(localizePath("/login", "vi")).toBe("/login");
    expect(localizePath("/login", "en")).toBe("/en/login");
    expect(localizePath("/", "en")).toBe("/en");
  });
});
