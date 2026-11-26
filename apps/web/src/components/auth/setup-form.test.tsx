import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { SetupForm, suggestSlug } from "./setup-form";

// Điều hướng phải đi qua router có locale của next-intl (@/i18n/navigation).
const replace = vi.fn();
const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
}));

const user = { id: "1", email: "leader@acme.dev", name: "Trưởng nhóm", role: "leader" };
const invite = {
  invite: {
    id: "inv1",
    projectId: "p1",
    status: "active",
    expiresAt: "2026-12-04T00:00:00Z",
    maxUses: null,
    usedCount: 0,
    revokedAt: null,
    createdAt: "2026-11-27T00:00:00Z",
    createdBy: { id: "1", email: "leader@acme.dev", name: "Trưởng nhóm" },
  },
  code: "Zm9vYmFyYmF6cXV4",
  url: "http://localhost:3130/i/Zm9vYmFyYmF6cXV4",
  installCommand: "irm http://localhost:3130/install.ps1?code=Zm9vYmFyYmF6cXV4 | iex",
};

async function fillAccount(u: ReturnType<typeof userEvent.setup>) {
  await u.type(screen.getByLabelText("Họ tên"), "Trưởng nhóm");
  await u.type(screen.getByLabelText("Email"), "leader@acme.dev");
  await u.type(screen.getByLabelText("Mật khẩu"), "teamlens123");
  await u.type(screen.getByLabelText("Nhập lại mật khẩu"), "teamlens123");
  await u.click(screen.getByRole("button", { name: "Tiếp tục" }));
}

describe("suggestSlug", () => {
  it("bỏ dấu tiếng Việt và ký tự lạ", () => {
    expect(suggestSlug("Đội Web Ăn Uống!")).toBe("doi-web-an-uong");
    expect(suggestSlug("  --Acme  API-- ")).toBe("acme-api");
    expect(suggestSlug("a".repeat(70))).toHaveLength(64);
  });
});

describe("SetupForm", () => {
  beforeEach(() => {
    replace.mockReset();
    refresh.mockReset();
  });

  it("đi hết 3 bước: gửi kèm project rồi hiện link mời và câu lệnh để copy", async () => {
    const u = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ user, invite }, 201));
    renderWithProviders(<SetupForm />);
    await fillAccount(u);

    // Chưa gọi API ở bước tài khoản.
    expect(fetchMock).not.toHaveBeenCalled();
    await u.type(screen.getByLabelText("Tên project"), "Đội Web");
    expect(screen.getByLabelText("Slug")).toHaveValue("doi-web");
    await u.type(screen.getByLabelText("Repo pattern 1"), "github.com/acme/*");
    await u.click(screen.getByRole("button", { name: "Thêm repo" }));
    await u.type(screen.getByLabelText("Repo pattern 2"), "github.com/acme/api");
    await u.click(screen.getByRole("button", { name: "Tạo và lấy link mời" }));

    expect(await screen.findByText(invite.url)).toBeInTheDocument();
    expect(screen.getByText(invite.installCommand)).toBeInTheDocument();
    expect(screen.getByText(`tl join ${invite.url}`)).toBeInTheDocument();
    expect(screen.getByText(/Gửi link này cho cả nhóm/)).toBeInTheDocument();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/setup");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Trưởng nhóm",
      email: "leader@acme.dev",
      password: "teamlens123",
      project: {
        name: "Đội Web",
        slug: "doi-web",
        repoPatterns: ["github.com/acme/*", "github.com/acme/api"],
      },
    });

    await u.click(screen.getByRole("button", { name: "Sao chép: Máy đã có tl" }));
    expect(await navigator.clipboard.readText()).toBe(`tl join ${invite.url}`);

    expect(replace).not.toHaveBeenCalled();
    await u.click(screen.getByRole("button", { name: "Vào dashboard" }));
    expect(replace).toHaveBeenCalledWith("/");
    expect(refresh).toHaveBeenCalled();
  });

  it("slug sửa tay thì không bị tên project ghi đè", async () => {
    const u = userEvent.setup();
    renderWithProviders(<SetupForm />);
    await fillAccount(u);
    await u.type(screen.getByLabelText("Slug"), "web");
    await u.type(screen.getByLabelText("Tên project"), "Đội Web");
    expect(screen.getByLabelText("Slug")).toHaveValue("web");
  });

  it("bắt buộc ít nhất một repo pattern khi tạo project", async () => {
    const u = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderWithProviders(<SetupForm />);
    await fillAccount(u);
    await u.type(screen.getByLabelText("Tên project"), "Web");
    await u.click(screen.getByRole("button", { name: "Tạo và lấy link mời" }));
    expect(await screen.findByText("Nhập ít nhất một repo pattern.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bỏ qua bước project: gửi không có project rồi vào dashboard", async () => {
    const u = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ user }, 201));
    renderWithProviders(<SetupForm />);
    await fillAccount(u);
    await u.click(screen.getByRole("button", { name: "Bỏ qua, tạo project sau" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      name: "Trưởng nhóm",
      email: "leader@acme.dev",
      password: "teamlens123",
    });
  });

  it("repo pattern sai thì hiện lỗi ở bước project", async () => {
    const u = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "invalid_pattern", message: "Repo pattern không hợp lệ" }, 400),
    );
    renderWithProviders(<SetupForm />);
    await fillAccount(u);
    await u.type(screen.getByLabelText("Tên project"), "Web");
    await u.type(screen.getByLabelText("Repo pattern 1"), "???");
    await u.click(screen.getByRole("button", { name: "Tạo và lấy link mời" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Repo pattern không hợp lệ");
    expect(screen.getByLabelText("Tên project")).toHaveValue("Web");
  });

  it("409 already_setup thì hiện thông báo và link đăng nhập", async () => {
    const u = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "already_setup", message: "Đã thiết lập" }, 409),
    );
    renderWithProviders(<SetupForm />);
    await fillAccount(u);
    await u.click(screen.getByRole("button", { name: "Bỏ qua, tạo project sau" }));

    expect(await screen.findByText("Máy chủ đã được thiết lập. Hãy đăng nhập.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tới trang đăng nhập" })).toHaveAttribute("href", "/login");
    expect(replace).not.toHaveBeenCalled();
  });
});
