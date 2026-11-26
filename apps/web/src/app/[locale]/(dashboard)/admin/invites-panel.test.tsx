import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { InvitesPanel } from "./invites-panel";

const leader = { id: "u1", email: "leader@acme.dev", name: "Trưởng nhóm" };
const base = {
  projectId: "p1",
  revokedAt: null,
  createdAt: "2026-11-27T00:00:00Z",
  expiresAt: "2026-12-04T03:00:00Z",
};
const invites = [
  { ...base, id: "a", status: "active", maxUses: 5, usedCount: 2, createdBy: leader },
  { ...base, id: "b", status: "revoked", maxUses: null, usedCount: 0, createdBy: null },
];
const created = {
  invite: { ...base, id: "c", status: "active", maxUses: 10, usedCount: 0, createdBy: leader },
  code: "bmV3Y29kZW5ld2NvZGU",
  url: "http://localhost:3130/i/bmV3Y29kZW5ld2NvZGU",
  installCommand: "irm http://localhost:3130/install.ps1?code=bmV3Y29kZW5ld2NvZGU | iex",
};

/** Mock fetch theo method + path, ghi lại các request. */
function mockApi(routes: Record<string, () => Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const handler = routes[key];
    if (!handler) throw new Error("Không mock: " + key);
    return handler();
  });
}

describe("InvitesPanel", () => {
  it("liệt kê link: trạng thái, lượt dùng, người tạo; chỉ link còn dùng được mới thu hồi được", async () => {
    mockApi({ "GET /api/v1/projects/p1/invites": () => jsonResponse(invites) });
    renderWithProviders(<InvitesPanel projectId="p1" />);

    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Đang dùng được")).toBeInTheDocument();
    expect(items[0]).toHaveTextContent("Đã dùng 2/5");
    expect(items[0]).toHaveTextContent("Tạo bởi Trưởng nhóm");
    expect(within(items[0]).getByRole("button", { name: "Thu hồi" })).toBeInTheDocument();
    expect(within(items[1]).getByText("Đã thu hồi")).toBeInTheDocument();
    expect(items[1]).toHaveTextContent("Đã dùng 0 (không giới hạn)");
    expect(items[1]).toHaveTextContent("Người tạo đã bị xóa");
    expect(within(items[1]).queryByRole("button")).not.toBeInTheDocument();
  });

  it("tạo link mới: gửi số ngày + giới hạn lượt, hiện url và câu lệnh một lần", async () => {
    const u = userEvent.setup();
    const fetchMock = mockApi({
      "GET /api/v1/projects/p1/invites": () => jsonResponse([]),
      "POST /api/v1/projects/p1/invites": () => jsonResponse(created, 201),
    });
    renderWithProviders(<InvitesPanel projectId="p1" />);
    expect(await screen.findByText("Chưa có link mời nào.")).toBeInTheDocument();

    const days = screen.getByLabelText("Hết hạn sau (ngày)");
    await u.clear(days);
    await u.type(days, "3");
    await u.type(screen.getByLabelText("Giới hạn lượt (trống: không giới hạn)"), "10");
    await u.click(screen.getByRole("button", { name: "Tạo link mời" }));

    expect(await screen.findByText(created.url)).toBeInTheDocument();
    expect(screen.getByText(created.installCommand)).toBeInTheDocument();
    expect(screen.getByText(`tl join ${created.url}`)).toBeInTheDocument();
    expect(screen.getByText(/chỉ hiện một lần/)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ expiresInDays: 3, maxUses: 10 });

    await u.click(screen.getByRole("button", { name: "Sao chép: Link mời" }));
    expect(await navigator.clipboard.readText()).toBe(created.url);

    await u.click(screen.getByRole("button", { name: "Đã sao chép, ẩn đi" }));
    expect(screen.queryByText(created.url)).not.toBeInTheDocument();
  });

  it("không nhập giới hạn lượt thì gửi maxUses null", async () => {
    const u = userEvent.setup();
    const fetchMock = mockApi({
      "GET /api/v1/projects/p1/invites": () => jsonResponse([]),
      "POST /api/v1/projects/p1/invites": () => jsonResponse(created, 201),
    });
    renderWithProviders(<InvitesPanel projectId="p1" />);
    await u.click(await screen.findByRole("button", { name: "Tạo link mời" }));
    await screen.findByText(created.url);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ expiresInDays: 7, maxUses: null });
  });

  it("thu hồi phải xác nhận; hủy thì không gọi API", async () => {
    const u = userEvent.setup();
    const fetchMock = mockApi({
      "GET /api/v1/projects/p1/invites": () => jsonResponse(invites),
      "DELETE /api/v1/projects/p1/invites/a": () => new Response(null, { status: 204 }),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderWithProviders(<InvitesPanel projectId="p1" />);
    const button = await screen.findByRole("button", { name: "Thu hồi" });

    await u.click(button);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    await u.click(button);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true),
    );
  });
});
