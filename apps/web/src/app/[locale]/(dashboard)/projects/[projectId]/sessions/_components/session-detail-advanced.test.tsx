import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionChild, SessionNote } from "@teamlens/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail, SessionTurn } from "@/lib/api/types";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { SessionDetailView } from "./session-detail";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
}));

function turn(seq: number, overrides: Partial<SessionTurn>): SessionTurn {
  return {
    seq,
    role: "assistant",
    kind: "reply",
    ts: "2026-11-20T01:00:00.000Z",
    model: null,
    text: null,
    tool: null,
    output: null,
    diff: null,
    usage: null,
    attachments: [],
    redactions: [],
    interrupted: false,
    reasoningEffort: null,
    ...overrides,
  };
}

const AGENT_ID = "a8bc93c72f4c160e0";

function child(id: string, overrides: Partial<SessionChild> = {}): SessionChild {
  return {
    id,
    sourceId: `claude_code:s-1:${AGENT_ID}`,
    agent: "claude_code",
    title: `Việc của ${id}`,
    startedAt: "2026-11-20T01:01:00.000Z",
    endedAt: "2026-11-20T01:02:00.000Z",
    turnCount: 2,
    ...overrides,
  };
}

function detail(overrides: Partial<SessionDetail>): SessionDetail {
  return {
    id: "s-1",
    projectId: "p-1",
    user: { id: "u-member", email: null, name: "Thành viên 1" },
    agent: "claude_code",
    agentVersion: null,
    model: null,
    repoRemote: "github.com/acme/app",
    branch: null,
    cwdRelative: "",
    startedAt: "2026-11-20T01:00:00.000Z",
    endedAt: null,
    turnCount: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    title: "Phiên chính",
    parentSessionId: null,
    childCount: 0,
    permissionMode: null,
    workType: null,
    sourceId: "claude_code:s-1",
    device: null,
    instructionFiles: null,
    childSessionIds: [],
    children: [],
    turns: [],
    ...overrides,
  };
}

function note(id: string, turnSeq: number | null, authorId = "u-leader"): SessionNote {
  return {
    id,
    sessionId: "s-1",
    turnSeq,
    body: `Ghi chú ${id}`,
    author: { id: authorId, email: "leader@teamlens.local", name: "Leader" },
    createdAt: "2026-11-21T02:00:00.000Z",
  };
}

type Route = (url: string, init?: RequestInit) => Response | undefined;

/** fetch giả theo URL; route không khớp trả 404. */
function mockFetch(route: Route) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return route(url, init) ?? jsonResponse({ error: "not_found", message: "x" }, 404);
  });
}

afterEach(() => vi.restoreAllMocks());

describe("Session con lồng trong session cha", () => {
  const parent = detail({
    childCount: 2,
    childSessionIds: ["c-1", "c-2"],
    children: [child("c-1"), child("c-2", { sourceId: "claude_code:s-1:zzzzzzzzzz", startedAt: "2026-11-21T00:00:00.000Z" })],
    turns: [
      turn(0, { role: "user", kind: "prompt", text: "Làm giúp" }),
      turn(1, { kind: "tool_call", tool: { name: "Agent", input: { description: "Rà soát code" }, status: "ok" } }),
      turn(2, {
        role: "user",
        kind: "tool_result",
        tool: { name: "Agent", input: null, status: "ok" },
        output: { text: `Xong.\nagentId: ${AGENT_ID} (internal ID)`, truncated: false, originalBytes: null },
      }),
    ],
  });

  it("ghép session con vào turn tool theo agentId, phần không ghép được ở khối cuối", async () => {
    const fetchMock = mockFetch((url) => {
      if (url.endsWith("/sessions/c-1"))
        return jsonResponse(
          detail({ id: "c-1", parentSessionId: "s-1", turns: [turn(0, { role: "user", kind: "prompt", text: "Lệnh cho subagent" })] }),
        );
      if (url.endsWith("/notes")) return jsonResponse({ items: [] });
      return undefined;
    });
    renderWithProviders(<SessionDetailView session={parent} />);

    const turn1 = document.getElementById("turn-1")!;
    const embedded = within(turn1).getByTestId("child-session");
    expect(embedded).toHaveTextContent("Việc của c-1");
    expect(within(embedded).getByRole("link", { name: /Mở trang riêng/ })).toHaveAttribute(
      "href",
      "/projects/p-1/sessions/c-1",
    );

    const section = screen.getByRole("region", { name: "Session con" });
    expect(within(section).getByText("Việc của c-2")).toBeInTheDocument();

    // Chưa mở thì chưa tải session con.
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/sessions/c-1"))).toBe(false);
    await userEvent.click(within(embedded).getByRole("button", { name: /Việc của c-1/ }));
    expect(await within(embedded).findByText("Lệnh cho subagent")).toBeInTheDocument();
  });
});

describe("Ghi chú của leader theo turn", () => {
  const session = detail({
    turns: [turn(0, { role: "user", kind: "prompt", text: "Prompt" }), turn(1, { text: "Trả lời" })],
  });

  it("member thấy ghi chú về mình nhưng không có nút thêm/xóa", async () => {
    mockFetch((url) => (url.endsWith("/notes") ? jsonResponse({ items: [note("n-1", 1), note("n-2", null)] }) : undefined));
    renderWithProviders(<SessionDetailView session={session} viewer={{ id: "u-member", isLeader: false }} />);

    const turn1 = document.getElementById("turn-1")!;
    expect(await within(turn1).findByText("Ghi chú n-1")).toBeInTheDocument();
    expect(screen.getByText("Ghi chú chung")).toBeInTheDocument();
    expect(screen.getByText("Ghi chú n-2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Thêm ghi chú/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Xóa ghi chú" })).not.toBeInTheDocument();
  });

  it("leader thêm ghi chú cho turn và xóa ghi chú của mình", async () => {
    let items: SessionNote[] = [note("n-1", 0), note("n-other", 0, "u-other-leader")];
    const fetchMock = mockFetch((url, init) => {
      if (!url.includes("/notes")) return undefined;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { turnSeq: number; body: string };
        const created = { ...note("n-new", body.turnSeq), body: body.body };
        items = [...items, created];
        return jsonResponse(created, 201);
      }
      if (init?.method === "DELETE") {
        items = items.filter((n) => !url.endsWith(`/notes/${n.id}`));
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ items });
    });
    renderWithProviders(<SessionDetailView session={session} viewer={{ id: "u-leader", isLeader: true }} />);

    const turn1 = document.getElementById("turn-1")!;
    await userEvent.click(within(turn1).getByRole("button", { name: "Thêm ghi chú cho turn 1" }));
    const save = within(turn1).getByRole("button", { name: "Lưu ghi chú" });
    expect(save).toBeDisabled();
    await userEvent.type(within(turn1).getByRole("textbox"), "  Nên viết test  ");
    await userEvent.click(save);
    expect(await within(turn1).findByText("Nên viết test")).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/v1/sessions/s-1/notes");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ turnSeq: 1, body: "Nên viết test" });

    // Chỉ xóa được ghi chú của chính mình.
    const turn0 = document.getElementById("turn-0")!;
    expect(within(turn0).getAllByTestId("note")).toHaveLength(2);
    const deletes = within(turn0).getAllByRole("button", { name: "Xóa ghi chú" });
    expect(deletes).toHaveLength(1);
    await userEvent.click(deletes[0]);
    await waitFor(() => expect(within(turn0).queryByText("Ghi chú n-1")).not.toBeInTheDocument());
    expect(within(turn0).getByText("Ghi chú n-other")).toBeInTheDocument();
  });
});
