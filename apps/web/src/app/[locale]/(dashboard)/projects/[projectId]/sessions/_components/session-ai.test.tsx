import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiResult, SessionAiResults } from "@teamlens/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { FindingExplain, SessionAiCard } from "./session-ai";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
}));

const KEY = {
  key: {
    provider: "openai_compatible",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5:3b",
    keyHint: "",
    createdAt: "2026-11-20T01:00:00.000Z",
    updatedAt: "2026-11-20T01:00:00.000Z",
  },
};

function aiResult(kind: AiResult["kind"], result: Record<string, unknown>, subjectId = "s-1"): AiResult {
  return {
    id: `r-${kind}`,
    kind,
    subjectType: kind === "finding_explain" ? "finding" : "session",
    subjectId,
    locale: "vi",
    provider: "openai_compatible",
    model: "qwen2.5:3b",
    promptVersion: `${kind}@1`,
    inputTokens: 100,
    outputTokens: 50,
    result,
    createdAt: "2026-11-20T02:00:00.000Z",
  };
}

const SUMMARY = aiResult("session_summary", {
  title: "Sửa lỗi đăng nhập",
  summary: "Agent sửa hàm login.",
  workType: "bugfix",
  outcome: "Đã xong.",
  filesTouched: ["src/login.ts"],
  keyTurns: [{ seq: 3, note: "Sửa file" }],
});

const EMPTY: SessionAiResults = { summary: null, outcome: null, findingExplains: [] };

type Route = (url: string, init?: RequestInit) => Response | undefined;

function mockFetch(route: Route) {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    return route(url, init) ?? jsonResponse({ error: "not_found", message: "x" }, 404);
  });
  return fetchMock;
}

afterEach(() => vi.restoreAllMocks());

describe("SessionAiCard", () => {
  it("chưa có key: chỉ hiện link tới Cài đặt AI", async () => {
    mockFetch((url) => (url.endsWith("/me/llm-key") ? jsonResponse({ key: null }) : undefined));
    renderWithProviders(<SessionAiCard sessionId="s-1" />);

    const link = await screen.findByRole("link", { name: "Thêm API key" });
    expect(link).toHaveAttribute("href", "/settings/ai");
    expect(screen.queryByRole("button", { name: /Tóm tắt/ })).not.toBeInTheDocument();
  });

  it("có key: hiện kết quả đã lưu, link turn và ghi chú riêng tư", async () => {
    mockFetch((url) => {
      if (url.endsWith("/me/llm-key")) return jsonResponse(KEY);
      if (url.endsWith("/sessions/s-1/ai?locale=vi")) return jsonResponse({ ...EMPTY, summary: SUMMARY });
    });
    renderWithProviders(<SessionAiCard sessionId="s-1" />);

    expect(await screen.findByText("Sửa lỗi đăng nhập")).toBeInTheDocument();
    expect(screen.getByText("Sửa lỗi")).toBeInTheDocument();
    expect(screen.getByText("src/login.ts")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Turn 3" })).toHaveAttribute("href", "#turn-3");
    expect(screen.getByText(/Chỉ bạn thấy kết quả này · qwen2.5:3b/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Làm lại: Tóm tắt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Đánh giá kết quả" })).toBeInTheDocument();
  });

  it("bấm Đánh giá: khóa nút khi chạy, gửi locale, hiện trạng thái và bằng chứng", async () => {
    let release: (r: Response) => void = () => undefined;
    let postBody: unknown;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/me/llm-key")) return jsonResponse(KEY);
      if (url.endsWith("/sessions/s-1/ai?locale=en")) return jsonResponse(EMPTY);
      if (url.endsWith("/sessions/s-1/ai/outcome") && init?.method === "POST") {
        postBody = JSON.parse(String(init.body));
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return jsonResponse({ error: "not_found", message: "x" }, 404);
    });
    renderWithProviders(<SessionAiCard sessionId="s-1" />, { locale: "en" });

    const button = await screen.findByRole("button", { name: "Evaluate outcome" });
    await userEvent.click(button);
    const running = await screen.findAllByRole("button", { name: "Running…" });
    expect(running[0]).toBeDisabled();
    expect(postBody).toEqual({ locale: "en" });
    release(
      jsonResponse(
        aiResult("session_outcome", {
          status: "stuck_loop",
          explanation: "The user repeated the same correction.",
          evidence: [{ seq: 4, note: "still failing" }],
        }),
      ),
    );
    expect(await screen.findByText("Stuck in a loop")).toBeInTheDocument();
    expect(screen.getByText("still failing")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Turn 4" })).toHaveAttribute("href", "#turn-4");
    expect(screen.getByRole("button", { name: "Redo: Evaluate outcome" })).toBeEnabled();
  });

  it("lỗi key sai: thông báo dễ hiểu và gợi ý Cài đặt AI", async () => {
    mockFetch((url, init) => {
      if (url.endsWith("/me/llm-key")) return jsonResponse(KEY);
      if (url.includes("/sessions/s-1/ai?")) return jsonResponse(EMPTY);
      if (init?.method === "POST")
        return jsonResponse({ error: "llm_key_invalid", message: "Provider báo key sai" }, 422);
    });
    renderWithProviders(<SessionAiCard sessionId="s-1" />);

    await userEvent.click(await screen.findByRole("button", { name: "Tóm tắt" }));
    expect(await screen.findByText(/Nhà cung cấp AI từ chối API key/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Mở Cài đặt AI" })).toHaveAttribute("href", "/settings/ai");
  });

  it("API key lỗi (404 cũ): ẩn thẻ AI", async () => {
    mockFetch(() => undefined);
    const { container } = renderWithProviders(<SessionAiCard sessionId="s-1" />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("FindingExplain", () => {
  it("chưa có key thì không hiện nút", async () => {
    mockFetch((url) => (url.endsWith("/me/llm-key") ? jsonResponse({ key: null }) : undefined));
    const { container } = renderWithProviders(<FindingExplain sessionId="s-1" findingId="f-1" />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("bấm Giải thích: hiện why, advice và turn liên quan", async () => {
    mockFetch((url, init) => {
      if (url.endsWith("/me/llm-key")) return jsonResponse(KEY);
      if (url.includes("/sessions/s-1/ai?")) return jsonResponse(EMPTY);
      if (url.endsWith("/findings/f-1/ai/explain") && init?.method === "POST")
        return jsonResponse(
          aiResult(
            "finding_explain",
            { why: "Ba prompt liên tiếp báo vẫn lỗi.", advice: "Đưa ví dụ tái hiện.", turns: [{ seq: 6, note: "lần ba" }] },
            "f-1",
          ),
        );
    });
    renderWithProviders(<FindingExplain sessionId="s-1" findingId="f-1" />);

    await userEvent.click(await screen.findByRole("button", { name: "Giải thích" }));
    expect(await screen.findByText("Ba prompt liên tiếp báo vẫn lỗi.")).toBeInTheDocument();
    expect(screen.getByText("Đưa ví dụ tái hiện.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Turn 6" })).toHaveAttribute("href", "#turn-6");
    expect(screen.getByRole("button", { name: "Làm lại: Giải thích" })).toBeInTheDocument();
  });
});
