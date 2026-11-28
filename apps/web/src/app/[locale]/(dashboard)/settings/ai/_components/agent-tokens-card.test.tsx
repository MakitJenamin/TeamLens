import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import type { AgentToken } from "./api";
import { AgentTokensCard, claudeMcpCommand } from "./agent-tokens-card";

const SECRET = "tlp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const tokenA: AgentToken = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Claude Code trên laptop",
  lastUsedAt: null,
  createdAt: "2026-11-27T00:00:00Z",
  revokedAt: null,
};
const tokenB: AgentToken = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Codex",
  lastUsedAt: "2026-11-27T05:00:00Z",
  createdAt: "2026-11-26T00:00:00Z",
  revokedAt: null,
};

afterEach(() => vi.restoreAllMocks());

describe("AgentTokensCard", () => {
  it("lệnh mẫu thêm MCP vào Claude Code", () => {
    expect(claudeMcpCommand("https://tl.example.com", SECRET)).toBe(
      `claude mcp add --transport http teamlens https://tl.example.com/api/v1/mcp --header "Authorization: Bearer ${SECRET}"`,
    );
  });

  it("tạo token: hiện tlp_ một lần kèm lệnh mẫu, rồi danh sách cập nhật", async () => {
    const u = userEvent.setup();
    let list = [tokenB];
    const posted: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const key = `${init?.method ?? "GET"} ${String(input)}`;
      if (key === "GET /api/v1/me/agent-tokens") return jsonResponse({ tokens: list });
      if (key === "POST /api/v1/me/agent-tokens") {
        posted.push(JSON.parse(String(init?.body)));
        list = [tokenA, tokenB];
        return jsonResponse({ token: tokenA, secret: SECRET }, 201);
      }
      throw new Error("Không mock: " + key);
    });
    renderWithProviders(<AgentTokensCard />);

    expect(await screen.findByText("Codex")).toBeInTheDocument();
    expect(screen.getByText(/Dùng lần cuối/)).toBeInTheDocument();

    await u.type(screen.getByLabelText("Tên token"), "  Claude Code trên laptop ");
    await u.click(screen.getByRole("button", { name: "Tạo token" }));

    expect(await screen.findByText('Token "Claude Code trên laptop" đã tạo')).toBeInTheDocument();
    expect(posted).toEqual([{ name: "Claude Code trên laptop" }]);
    expect(screen.getByText(SECRET)).toBeInTheDocument();
    expect(
      screen.getByText(claudeMcpCommand(window.location.origin, SECRET)),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Tên token")).toHaveValue("");
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getByText("Chưa dùng")).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Tôi đã sao chép" }));
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it("thu hồi phải xác nhận bằng dialog; lỗi theo mã", async () => {
    const u = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    const deleted: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const key = `${init?.method ?? "GET"} ${String(input)}`;
      if (key === "GET /api/v1/me/agent-tokens") return jsonResponse({ tokens: [tokenA, tokenB] });
      if (key.startsWith("DELETE /api/v1/me/agent-tokens/")) {
        deleted.push(key);
        return jsonResponse({ error: "not_found", message: "Không tìm thấy token" }, 404);
      }
      throw new Error("Không mock: " + key);
    });
    renderWithProviders(<AgentTokensCard />);

    const items = await screen.findAllByRole("listitem");
    await u.click(within(items[1]).getByRole("button", { name: "Thu hồi: Codex" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent('Thu hồi token "Codex"?');
    await u.click(within(dialog).getByRole("button", { name: "Thu hồi" }));

    await waitFor(() => expect(deleted).toEqual([`DELETE /api/v1/me/agent-tokens/${tokenB.id}`]));
    expect(await screen.findByRole("alert")).toHaveTextContent("Không tìm thấy. Có thể đã bị thu hồi.");
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("chưa có token: không hiện danh sách", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ tokens: [] }));
    renderWithProviders(<AgentTokensCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("list")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Tạo token" })).toBeInTheDocument();
  });
});
