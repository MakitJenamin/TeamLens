import { describe, expect, it } from "vitest";
import { isProtectedPath, localizePath, resolveNextPath, safeNextPath, splitLocale } from "./auth-paths";

describe("splitLocale", () => {
  it("tách prefix en", () => {
    expect(splitLocale("/en/login")).toEqual({ locale: "en", path: "/login" });
    expect(splitLocale("/en")).toEqual({ locale: "en", path: "/" });
  });
  it("không prefix là vi", () => {
    expect(splitLocale("/me")).toEqual({ locale: "vi", path: "/me" });
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
  it("link mời và trang đổi ticket tl open là công khai", () => {
    expect(isProtectedPath("/i/Zm9vYmFyYmF6cXV4")).toBe(false);
    expect(isProtectedPath("/auth/cli")).toBe(false);
    expect(isProtectedPath("/items")).toBe(true);
  });
  it("dashboard cần đăng nhập", () => {
    expect(isProtectedPath("/")).toBe(true);
    expect(isProtectedPath("/me")).toBe(true);
    expect(isProtectedPath("/projects/abc/overview")).toBe(true);
    expect(isProtectedPath("/loginx")).toBe(true);
  });
});

describe("safeNextPath", () => {
  it("giữ đường dẫn nội bộ", () => {
    expect(safeNextPath("/projects/abc/sessions?page=2")).toBe("/projects/abc/sessions?page=2");
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

describe("resolveNextPath", () => {
  it("tách locale khỏi ?next= để dùng với router của next-intl", () => {
    expect(resolveNextPath("/en/projects/abc/sessions?page=2")).toEqual({ href: "/projects/abc/sessions?page=2", locale: "en" });
    expect(resolveNextPath("/me")).toEqual({ href: "/me", locale: "vi" });
  });
  it("đường dẫn ngoài bị thay bằng trang chủ", () => {
    expect(resolveNextPath("//evil.com")).toEqual({ href: "/", locale: "vi" });
  });
});
