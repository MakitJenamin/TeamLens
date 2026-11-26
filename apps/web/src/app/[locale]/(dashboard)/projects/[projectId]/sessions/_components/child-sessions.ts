import type { SessionChild } from "@teamlens/schema";
import type { SessionTurn } from "@/lib/api/types";

/** Tool sinh session con: Claude Code (`Task`, `Agent`, Skill chạy dạng fork), Codex (`spawn_agent`). */
const SPAWN_TOOLS = new Set(["Task", "Agent", "Skill", "spawn_agent"]);

/** Khoảng tối đa giữa lúc gọi tool và lúc session con bắt đầu để ghép theo thời gian. */
const TIME_WINDOW_MS = 2 * 60_000;
/** Đồng hồ hai file log có thể lệch nhẹ: cho phép session con "bắt đầu" sớm hơn tool call chút ít. */
const CLOCK_SKEW_MS = 5_000;

/**
 * Mã định danh của session con trong log của session cha. Claude Code: `claude_code:<sessionId>:<agentId>`
 * và kết quả tool `Task`/`Agent` có dòng `agentId: <agentId>`. Agent khác: phần sau dấu `:` đầu tiên.
 */
export function childAgentId(sourceId: string): string | null {
  const parts = sourceId.split(":");
  const id = parts.length >= 3 ? parts[parts.length - 1] : parts.slice(1).join(":");
  // Mã quá ngắn dễ khớp nhầm với văn bản bất kỳ.
  return id && id.length >= 6 ? id : null;
}

function turnText(turn: SessionTurn): string {
  return [turn.text ?? "", turn.output?.text ?? "", turn.tool?.input ? JSON.stringify(turn.tool.input) : ""].join("\n");
}

const isToolTurn = (turn: SessionTurn) => turn.kind === "tool_call" || turn.kind === "tool_result";

export interface ChildPlacement {
  /** Session con ghép được vào turn (theo `seq` của turn tool call, hoặc tool result nếu không có call). */
  byTurn: Map<number, SessionChild[]>;
  /** Session con không ghép được, hiện ở khối "Session con" cuối trang. */
  unplaced: SessionChild[];
}

/**
 * Ghép từng session con vào turn tool đã sinh ra nó:
 * 1. Theo mã agent xuất hiện trong output/input của turn tool (chính xác nhất).
 * 2. Không có thì theo thời gian: tool call `Task`/`Agent`/... gần nhất trước lúc session con bắt đầu
 *    (trong vòng 2 phút), mỗi tool call nhận tối đa một session con.
 * Ghép theo mã ở turn `tool_result` thì đưa về turn `tool_call` liền trước cùng tên tool để hiện gần lời gọi.
 */
export function placeChildSessions(turns: SessionTurn[], children: SessionChild[]): ChildPlacement {
  const byTurn = new Map<number, SessionChild[]>();
  const unplaced: SessionChild[] = [];
  const claimed = new Set<number>();
  const toolTurns = turns.filter(isToolTurn);
  const texts = new Map(toolTurns.map((t) => [t.seq, turnText(t)]));

  const callFor = (turn: SessionTurn): SessionTurn => {
    if (turn.kind === "tool_call") return turn;
    const index = toolTurns.indexOf(turn);
    for (let i = index - 1; i >= 0; i--) {
      const prev = toolTurns[i];
      if (prev.kind === "tool_call" && prev.tool?.name === turn.tool?.name && !claimed.has(prev.seq)) return prev;
    }
    return turn;
  };
  const place = (turn: SessionTurn, child: SessionChild) => {
    claimed.add(turn.seq);
    byTurn.set(turn.seq, [...(byTurn.get(turn.seq) ?? []), child]);
  };

  const pending: SessionChild[] = [];
  for (const child of children) {
    const agentId = childAgentId(child.sourceId);
    const hit = agentId ? toolTurns.find((t) => texts.get(t.seq)?.includes(agentId)) : undefined;
    if (hit) place(callFor(hit), child);
    else pending.push(child);
  }

  for (const child of pending) {
    const start = Date.parse(child.startedAt);
    let best: SessionTurn | undefined;
    for (const turn of toolTurns) {
      if (turn.kind !== "tool_call" || !SPAWN_TOOLS.has(turn.tool?.name ?? "") || claimed.has(turn.seq)) continue;
      const gap = start - Date.parse(turn.ts);
      if (gap < -CLOCK_SKEW_MS || gap > TIME_WINDOW_MS) continue;
      if (!best || Date.parse(turn.ts) > Date.parse(best.ts)) best = turn;
    }
    if (best) place(best, child);
    else unplaced.push(child);
  }

  return { byTurn, unplaced };
}
