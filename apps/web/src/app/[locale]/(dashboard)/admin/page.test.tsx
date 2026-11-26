import { beforeEach, expect, it, vi } from "vitest";
import { serverApi, serverApiOrNull } from "@/lib/api/server";
import AdminPage from "./page";

vi.mock("@/lib/api/server", () => ({ serverApi: vi.fn(), serverApiOrNull: vi.fn() }));
vi.mock("@/i18n/navigation", () => ({
  redirect: ({ href }: { href: string }) => { throw new Error("redirect " + href); },
}));
vi.mock("next-intl/server", () => ({
  setRequestLocale: vi.fn(), getTranslations: async () => (key: string) => key,
}));

const props = { params: Promise.resolve({ locale: "vi" }), searchParams: Promise.resolve({ tab: "users" }) };
beforeEach(() => vi.clearAllMocks());

it("yêu cầu đăng nhập trước khi đọc danh sách tài khoản", async () => {
  vi.mocked(serverApiOrNull).mockResolvedValue(null);
  await expect(AdminPage(props)).rejects.toThrow("redirect /login");
  expect(serverApi).not.toHaveBeenCalled();
});

it("chặn thành viên kể cả khi mở thẳng tab tài khoản", async () => {
  vi.mocked(serverApiOrNull).mockResolvedValue({ user: { isAdmin: false } });
  await expect(AdminPage(props)).rejects.toThrow("redirect /");
  expect(serverApi).not.toHaveBeenCalled();
});
