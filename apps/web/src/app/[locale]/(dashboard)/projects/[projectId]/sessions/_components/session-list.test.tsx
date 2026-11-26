import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionPage, SessionSummary } from "@/lib/api/types";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { SessionList } from "./session-list";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
}));

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    projectId: "p-1",
    user: { id: "u-1", email: "member1@teamlens.local", name: "Member Một" },
    agent: "claude_code",
    agentVersion: "2.1.4",
    model: "claude-opus-5-5",
    repoRemote: "github.com/acme/app",
    branch: "feat/x",
    cwdRelative: "",
    startedAt: "2026-11-20T01:00:00.000Z",
    endedAt: "2026-11-20T01:05:00.000Z",
    turnCount: 6,
    usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 },
    title: `Prompt ${id}`,
    parentSessionId: null,
    childCount: 0,
    permissionMode: null,
    ...overrides,
  };
}

const page = (items: SessionSummary[], nextCursor: string | null): SessionPage => ({ items, nextCursor });

describe("SessionList", () => {
  it("hiện bảng session với link chi tiết, thời lượng, token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(page([summary("s-1")], null)));
    renderWithProviders(<SessionList projectId="p-1" members={null} />);

    const link = await screen.findByRole("link", { name: "08:00 20/11/26" });
    expect(link).toHaveAttribute("href", "/projects/p-1/sessions/s-1");
    expect(screen.getByText("Prompt s-1")).toBeInTheDocument();
    expect(screen.getByText("5 phút")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.getByText("1,5 N")).toBeInTheDocument();
    // Member không có bộ lọc người.
    expect(screen.queryByLabelText("Thành viên")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tải thêm" })).not.toBeInTheDocument();
  });

  it("Tải thêm gửi cursor của trang trước và nối kết quả", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(page([summary("s-1")], "CURSOR-1")))
      .mockResolvedValueOnce(jsonResponse(page([summary("s-2")], null)));
    renderWithProviders(<SessionList projectId="p-1" members={null} />);

    await userEvent.click(await screen.findByRole("button", { name: "Tải thêm" }));
    expect(await screen.findByText("Prompt s-2")).toBeInTheDocument();
    expect(screen.getByText("Prompt s-1")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=CURSOR-1");
    expect(screen.queryByRole("button", { name: "Tải thêm" })).not.toBeInTheDocument();
  });

  it("lọc theo agent và người gửi tham số lên API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(page([], null)));
    renderWithProviders(
      <SessionList projectId="p-1" members={[{ id: "u-2", name: "Member Hai" }]} />,
    );

    expect(await screen.findByText("Chưa có session nào")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Agent"), "codex");
    await userEvent.selectOptions(screen.getByLabelText("Thành viên"), "u-2");
    await waitFor(() => {
      const url = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(url).toContain("agent=codex");
      expect(url).toContain("userId=u-2");
    });
  });

  it("hiện lỗi khi API trả lỗi", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "forbidden", message: "Bạn không có quyền thực hiện thao tác này" }, 403),
    );
    renderWithProviders(<SessionList projectId="p-1" members={null} />);

    expect(await screen.findByText("Không tải được danh sách session")).toBeInTheDocument();
    expect(screen.getByText("Bạn không có quyền thực hiện thao tác này")).toBeInTheDocument();
  });
});
