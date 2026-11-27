import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

const session: SessionDetail = {
  id: "s-1",
  projectId: "p-1",
  user: { id: "u-1", email: "member1@teamlens.local", name: "Member Một" },
  agent: "claude_code",
  agentVersion: "2.1.4",
  model: "claude-opus-5-5",
  repoRemote: "github.com/acme/app",
  branch: "feat/x",
  cwdRelative: "apps/api",
  startedAt: "2026-11-20T01:00:00.000Z",
  endedAt: "2026-11-20T01:05:00.000Z",
  turnCount: 4,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  title: "Thêm endpoint /health",
  parentSessionId: null,
  permissionMode: "bypass",
  sourceId: "claude_code:x",
  device: { id: "d-1", name: "PC" },
  instructionFiles: [{ path: "CLAUDE.md", bytes: 120 }],
  childCount: 1,
  childSessionIds: ["s-child"],
  children: [
    {
      id: "s-child",
      sourceId: "claude_code:x:a1",
      agent: "claude_code",
      title: "Việc con",
      startedAt: "2026-11-20T01:02:00.000Z",
      endedAt: null,
      turnCount: 2,
    },
  ],
  turns: [
    turn(0, { role: "user", kind: "prompt", text: "Dòng 1\n<script>alert(1)</script>" }),
    turn(1, { kind: "reply", text: "Mình sẽ làm", model: "claude-opus-5-5", interrupted: true }),
    turn(2, {
      kind: "tool_call",
      tool: { name: "Bash", input: { command: "pnpm test" }, status: "error" },
      output: { text: "FAIL đầu…cuối", truncated: true, originalBytes: 9000 },
    }),
    turn(3, {
      kind: "tool_call",
      tool: { name: "Write", input: { file_path: "src/a.ts" }, status: "ok" },
      diff: { path: "src/a.ts", patch: "@@ -1 +1 @@\n-cũ\n+mới", added: 1, removed: 1 },
    }),
  ],
};

describe("SessionDetailView", () => {
  it("hiện metadata, session con và giữ nội dung thô dạng text", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ error: "not_found", message: "x" }, 404));
    const { container } = renderWithProviders(<SessionDetailView session={session} />);

    expect(screen.getByRole("heading", { name: "Thêm endpoint /health" })).toBeInTheDocument();
    expect(screen.getByText("Bỏ qua mọi xác nhận")).toBeInTheDocument();
    expect(screen.getByText("CLAUDE.md")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Session con 1" })).toHaveAttribute(
      "href",
      "/projects/p-1/sessions/s-child",
    );
    // Nội dung prompt hiện nguyên văn, không thành thẻ HTML.
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    // Turn bị ngắt được đánh dấu.
    expect(screen.getByText("Bị ngắt")).toBeInTheDocument();
    // Findings 404 → không có khu vực finding.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Finding")).not.toBeInTheDocument();
  });

  it("tool call thu gọn mặc định, bấm để xem input và output bị cắt", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse([]));
    renderWithProviders(<SessionDetailView session={session} />);

    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.queryByText(/FAIL đầu/)).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /Bash/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/FAIL đầu/)).toBeInTheDocument();
    expect(screen.getByText(/Bản gốc 9.000 byte/)).toBeInTheDocument();
    expect(screen.getByText("Lỗi")).toBeInTheDocument();
  });

  it("diff ngắn tô màu bằng react-diff-view, mở sẵn", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse([]));
    renderWithProviders(<SessionDetailView session={session} />);

    const diff = screen.getByTestId("diff");
    expect(diff.querySelector(".diff-code-insert")).toHaveTextContent("mới");
    expect(diff.querySelector(".diff-code-delete")).toHaveTextContent("cũ");
    expect(diff).toHaveTextContent("@@ -1 +1 @@");
    expect(screen.getByRole("button", { name: /src\/a\.ts/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("diff lớn thu gọn mặc định, bấm mới render", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse([]));
    const lines = Array.from({ length: 3000 }, (_, i) => `+dòng ${i}`);
    const big: SessionDetail = {
      ...session,
      turns: [
        turn(0, {
          kind: "tool_call",
          tool: { name: "Write", input: { file_path: "big.ts" }, status: "ok" },
          diff: { path: "big.ts", patch: `@@ -0,0 +1,3000 @@\n${lines.join("\n")}`, added: 3000, removed: 0 },
        }),
      ],
    };
    renderWithProviders(<SessionDetailView session={big} />);

    const diff = screen.getByTestId("diff");
    expect(diff.querySelector(".diff-code-insert")).toBeNull();
    expect(diff).toHaveTextContent("+3000");
    expect(diff).toHaveTextContent("3001 dòng");
    await userEvent.click(screen.getByRole("button", { name: /big\.ts/ }));
    expect(diff.querySelectorAll(".diff-code-insert")).toHaveLength(3000);
  });

  it("hiện finding và đánh dấu turn dính finding", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse([
        { id: "f-1", ruleId: "yolo-mode", severity: "high", message: "Chạy ở chế độ bypass", turnSeq: 2 },
        { bogus: true },
      ]),
    );
    renderWithProviders(<SessionDetailView session={session} />);

    expect(await screen.findByText("Finding")).toBeInTheDocument();
    expect(screen.getByText("yolo-mode")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Turn 2" })).toHaveAttribute("href", "#turn-2");
    expect(screen.getByText("Có finding")).toBeInTheDocument();
    expect(screen.getAllByText("Chạy ở chế độ bypass")).toHaveLength(2);
  });
});
