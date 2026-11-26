import type { SessionChild } from "@teamlens/schema";
import { describe, expect, it } from "vitest";
import type { SessionTurn } from "@/lib/api/types";
import { childAgentId, placeChildSessions } from "./child-sessions";
import { parsePatch } from "./diff-view";

function turn(seq: number, ts: string, overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    seq,
    role: "assistant",
    kind: "tool_call",
    ts,
    model: null,
    text: null,
    tool: { name: "Agent", input: null, status: "ok" },
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

function child(id: string, sourceId: string, startedAt: string): SessionChild {
  return { id, sourceId, agent: "claude_code", title: null, startedAt, endedAt: null, turnCount: 1 };
}

describe("childAgentId", () => {
  it("lấy agentId cuối của Claude Code, bỏ mã quá ngắn", () => {
    expect(childAgentId("claude_code:abc-123:a8bc93c72f4c160e0")).toBe("a8bc93c72f4c160e0");
    expect(childAgentId("codex:019a-thread-id")).toBe("019a-thread-id");
    expect(childAgentId("claude_code:s:a1")).toBeNull();
  });
});

describe("placeChildSessions", () => {
  it("ghép theo agentId trong output, đưa về turn tool_call cùng tên liền trước", () => {
    const turns = [
      turn(1, "2026-11-20T01:00:00Z"),
      turn(2, "2026-11-20T01:05:00Z", {
        kind: "tool_result",
        output: { text: "kết quả\nagentId: aaaaaaaaaa1 (internal)", truncated: false, originalBytes: null },
      }),
    ];
    const c = child("c", "claude_code:s:aaaaaaaaaa1", "2026-11-20T03:00:00Z");
    const { byTurn, unplaced } = placeChildSessions(turns, [c]);
    expect(byTurn.get(1)).toEqual([c]);
    expect(unplaced).toEqual([]);
  });

  it("không có agentId thì ghép theo thời gian với tool Task/Agent/Skill gần nhất trước đó", () => {
    const turns = [
      turn(1, "2026-11-20T01:00:00Z", { tool: { name: "Task", input: null, status: "ok" } }),
      turn(2, "2026-11-20T01:00:30Z", { tool: { name: "Bash", input: null, status: "ok" } }),
      turn(3, "2026-11-20T01:01:00Z", { tool: { name: "Skill", input: null, status: "ok" } }),
    ];
    const first = child("c1", "claude_code:s:bbbbbbbbbb1", "2026-11-20T01:01:02Z");
    const second = child("c2", "claude_code:s:bbbbbbbbbb2", "2026-11-20T01:01:03Z");
    const late = child("c3", "claude_code:s:bbbbbbbbbb3", "2026-11-20T02:00:00Z");
    const { byTurn, unplaced } = placeChildSessions(turns, [first, second, late]);
    expect(byTurn.get(3)).toEqual([first]);
    expect(byTurn.get(1)).toEqual([second]);
    expect(byTurn.has(2)).toBe(false);
    expect(unplaced).toEqual([late]);
  });
});

describe("parsePatch", () => {
  it("thêm phần đầu file cho patch chỉ có hunk", () => {
    const file = parsePatch({ path: "src/a b.ts", patch: "@@ -1,2 +1,2 @@\n a\n-b\n+c" });
    expect(file?.hunks).toHaveLength(1);
    expect(file?.hunks[0].changes.map((c) => c.type)).toEqual(["normal", "delete", "insert"]);
  });

  it("patch không có hunk trả null", () => {
    expect(parsePatch({ path: "x", patch: "không phải diff" })).toBeNull();
  });
});
