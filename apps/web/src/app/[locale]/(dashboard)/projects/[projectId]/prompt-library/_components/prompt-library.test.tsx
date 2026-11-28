import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AiResult,
  PromptCandidate,
  PromptCandidatesSaved,
  PromptLibraryItem,
} from "@teamlens/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { PromptLibrary } from "./prompt-library";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
}));

const U1 = "11111111-1111-4111-8111-111111111111";
const LIBRARY = "/api/v1/projects/p-1/prompt-library";
const CANDIDATES = "/api/v1/projects/p-1/ai/prompt-candidates";

function item(over: Partial<PromptLibraryItem> = {}): PromptLibraryItem {
  return {
    id: "i1",
    prompt: "Sửa lỗi đăng nhập khi mật khẩu có ký tự đặc biệt, thêm test tái hiện rồi sửa",
    note: "Nêu rõ triệu chứng.",
    workType: "bugfix",
    author: { userId: U1, name: "Member Một" },
    hideAuthor: false,
    sessionId: null,
    turnSeq: null,
    createdAt: "2026-11-27T10:00:00.000Z",
    ...over,
  };
}

const candidate: PromptCandidate = {
  sessionId: "s-9",
  turnSeq: 1,
  userId: U1,
  userName: "Member Một",
  startedAt: "2026-11-26T08:00:00.000Z",
  score: 88,
  workType: "feature",
  prompt: "Thêm trang cài đặt với ba mục, mỗi mục có test",
  title: "Thêm trang cài đặt có test",
  why: "Nêu rõ phạm vi và yêu cầu test.",
};

function aiResult(candidates: PromptCandidate[], considered = candidates.length): AiResult {
  return {
    id: "r1",
    kind: "prompt_candidates",
    subjectType: "project",
    subjectId: "p-1",
    locale: "vi",
    provider: "anthropic",
    model: "claude-test",
    promptVersion: "prompt_candidates@1",
    inputTokens: 1,
    outputTokens: 1,
    createdAt: "2026-11-28T09:00:00.000Z",
    result: { candidates, considered },
  } as AiResult;
}

type ReqBody = { sessionId?: string; turnSeq?: number; note?: string; hideAuthor?: boolean; locale?: string; from?: string };

interface Routes {
  items?: PromptLibraryItem[];
  hasKey?: boolean;
  saved?: PromptCandidatesSaved;
  onRequest?: (method: string, path: string, body: ReqBody) => Response | undefined;
}

function mockApi({ items = [item()], hasKey = true, saved = { result: null }, onRequest }: Routes = {}) {
  const requests: { method: string; path: string; body: ReqBody }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://x");
    const method = init?.method ?? "GET";
    const body: ReqBody = init?.body ? (JSON.parse(String(init.body)) as ReqBody) : {};
    requests.push({ method, path: url.pathname, body });
    const custom = onRequest?.(method, url.pathname, body);
    if (custom) return custom;
    if (url.pathname === "/api/v1/me/llm-key")
      return jsonResponse(hasKey ? { key: { provider: "anthropic", model: "claude-test" } } : { key: null });
    if (url.pathname === LIBRARY && method === "GET") return jsonResponse({ items });
    if (url.pathname === CANDIDATES && method === "GET") return jsonResponse(saved);
    return jsonResponse({ error: "not_found", message: "x" }, 404);
  });
  return requests;
}

afterEach(() => vi.restoreAllMocks());

describe("PromptLibrary: góc nhìn của thành viên", () => {
  it("hiện prompt, ghi chú, tác giả, loại việc; không có khu tìm ứng viên hay nút gỡ", async () => {
    mockApi({ items: [item(), item({ id: "i2", author: null, hideAuthor: true, prompt: "Viết changelog từ các PR đã merge tuần này", note: null, workType: null })] });
    renderWithProviders(<PromptLibrary projectId="p-1" isLeader={false} />);

    const cards = await screen.findAllByTestId("library-item");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText("Member Một")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Sửa lỗi")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Nêu rõ triệu chứng.")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Ẩn danh")).toBeInTheDocument();
    expect(screen.queryByTestId("candidate-finder")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gỡ khỏi thư viện" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Mở session" })).not.toBeInTheDocument();
  });

  it("sao chép prompt vào clipboard", async () => {
    mockApi();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithProviders(<PromptLibrary projectId="p-1" isLeader={false} />);
    await userEvent.click(await screen.findByRole("button", { name: "Sao chép" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(item().prompt));
    expect(await screen.findByRole("button", { name: "Đã chép" })).toBeInTheDocument();
  });

  it("thư viện rỗng hiện gợi ý dành cho thành viên; lỗi tải hiện thông báo", async () => {
    mockApi({ items: [] });
    const first = renderWithProviders(<PromptLibrary projectId="p-1" isLeader={false} />);
    expect(await screen.findByText("Chưa có prompt mẫu nào")).toBeInTheDocument();
    expect(screen.getByText("Khi leader duyệt prompt mẫu, chúng sẽ hiện ở đây.")).toBeInTheDocument();
    first.unmount();

    vi.restoreAllMocks();
    mockApi({ onRequest: (m, p) => (m === "GET" && p === LIBRARY ? jsonResponse({ error: "forbidden", message: "Bạn không có quyền thực hiện thao tác này" }, 403) : undefined) });
    renderWithProviders(<PromptLibrary projectId="p-1" isLeader={false} />);
    expect(await screen.findByText("Không tải được thư viện prompt")).toBeInTheDocument();
  });

  it("nội dung prompt, ghi chú và tên có HTML hiển thị dạng chữ", async () => {
    mockApi({
      items: [item({ prompt: "<script>alert(1)</script> sửa lỗi", note: "<img src=x onerror=alert(1)>", author: { userId: U1, name: "<b>Tên</b>" } })],
    });
    renderWithProviders(<PromptLibrary projectId="p-1" isLeader={false} />);
    expect(await screen.findByText("<script>alert(1)</script> sửa lỗi")).toBeInTheDocument();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(screen.getByText("<b>Tên</b>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });
});

describe("PromptLibrary: góc nhìn của leader", () => {
  it("thấy link mở session, nhãn đang ẩn tên, nút gỡ; gỡ thì gọi DELETE rồi tải lại danh sách", async () => {
    let items = [item({ id: "i1", sessionId: "s-5", turnSeq: 3, hideAuthor: true })];
    const requests = mockApi({
      onRequest: (method, path) => {
        if (method === "GET" && path === LIBRARY) return jsonResponse({ items });
        if (method === "DELETE" && path === `${LIBRARY}/i1`) {
          items = [];
          return new Response(null, { status: 204 });
        }
        return undefined;
      },
    });
    renderWithProviders(<PromptLibrary projectId="p-1" isLeader />);
    const card = await screen.findByTestId("library-item");
    expect(within(card).getByRole("link", { name: "Mở session" })).toHaveAttribute("href", "/projects/p-1/sessions/s-5#turn-3");
    expect(within(card).getByText("Đang ẩn tên với thành viên")).toBeInTheDocument();

    await userEvent.click(within(card).getByRole("button", { name: "Gỡ khỏi thư viện" }));
    expect(await screen.findByText("Chưa có prompt mẫu nào")).toBeInTheDocument();
    expect(requests.some((r) => r.method === "DELETE" && r.path === `${LIBRARY}/i1`)).toBe(true);
  });

  it("chưa có key: chỉ có link tới Cài đặt AI, không có nút tìm", async () => {
    mockApi({ hasKey: false });
    renderWithProviders(<PromptLibrary projectId="p-1" isLeader />);
    const link = await screen.findByRole("link", { name: /Thêm API key AI để tìm prompt mẫu/ });
    expect(link).toHaveAttribute("href", "/settings/ai");
    expect(screen.queryByRole("button", { name: "Tìm prompt mẫu" })).not.toBeInTheDocument();
  });

  it("bấm tìm gửi POST với locale và from theo khoảng đã chọn, hiện ứng viên kèm lý do", async () => {
    const requests = mockApi({
      onRequest: (method, path) => (method === "POST" && path === CANDIDATES ? jsonResponse(aiResult([candidate], 3)) : undefined),
    });
    renderWithProviders(<PromptLibrary projectId="p-1" isLeader />);
    await userEvent.selectOptions(await screen.findByLabelText("Khoảng thời gian"), "90");
    await userEvent.click(await screen.findByRole("button", { name: "Tìm prompt mẫu" }));

    const card = await screen.findByTestId("candidate");
    expect(within(card).getByText("Thêm trang cài đặt có test")).toBeInTheDocument();
    expect(within(card).getByText("Điểm 88")).toBeInTheDocument();
    expect(within(card).getByText("Nêu rõ phạm vi và yêu cầu test.")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Mở session" })).toHaveAttribute("href", "/projects/p-1/sessions/s-9#turn-1");
    expect(screen.getByText("Đã xét 3 session đạt điều kiện.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tìm lại" })).toBeInTheDocument();

    const post = requests.find((r) => r.method === "POST");
    expect(post?.path).toBe(CANDIDATES);
    expect(post?.body.locale).toBe("vi");
    const days = (Date.now() - Date.parse(post?.body.from ?? "")) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
  });

  it("thêm vào thư viện gửi sessionId, turnSeq, lý do làm ghi chú và hideAuthor; xong thì tải lại thư viện", async () => {
    let items: PromptLibraryItem[] = [];
    const requests = mockApi({
      saved: { result: aiResult([candidate]) },
      onRequest: (method, path, body) => {
        if (method === "GET" && path === LIBRARY) return jsonResponse({ items });
        if (method === "POST" && path === LIBRARY) {
          items = [item({ id: "new", prompt: candidate.prompt, note: body.note ?? null, hideAuthor: body.hideAuthor ?? false })];
          return jsonResponse(items[0], 201);
        }
        return undefined;
      },
    });
    renderWithProviders(<PromptLibrary projectId="p-1" isLeader />);
    const card = await screen.findByTestId("candidate");
    await userEvent.click(within(card).getByLabelText("Ẩn tên tác giả với thành viên"));
    await userEvent.click(within(card).getByRole("button", { name: "Thêm vào thư viện" }));

    expect(await within(card).findByText("Đã thêm vào thư viện")).toBeInTheDocument();
    const post = requests.find((r) => r.method === "POST" && r.path === LIBRARY);
    expect(post?.body).toEqual({ sessionId: "s-9", turnSeq: 1, note: "Nêu rõ phạm vi và yêu cầu test.", hideAuthor: true });
    expect(await screen.findByTestId("library-item")).toBeInTheDocument();
  });

  it("đã có trong thư viện (409) thì báo đã có, không coi là lỗi", async () => {
    mockApi({
      saved: { result: aiResult([candidate]) },
      onRequest: (method, path) =>
        method === "POST" && path === LIBRARY ? jsonResponse({ error: "already_in_library", message: "x" }, 409) : undefined,
    });
    renderWithProviders(<PromptLibrary projectId="p-1" isLeader />);
    await userEvent.click(await screen.findByRole("button", { name: "Thêm vào thư viện" }));
    expect(await screen.findByText("Đã có trong thư viện")).toBeInTheDocument();
  });

  it("kết quả rỗng nói AI không thấy prompt nào đáng thêm", async () => {
    mockApi({ saved: { result: aiResult([], 5) } });
    renderWithProviders(<PromptLibrary projectId="p-1" isLeader />);
    expect(await screen.findByText(/Trong 5 session đã xét, AI không thấy prompt nào đáng/)).toBeInTheDocument();
  });

  it.each([
    ["no_candidates", 409, /Chưa có session nào đủ tốt/],
    ["llm_key_invalid", 422, /Nhà cung cấp AI từ chối API key/],
    ["llm_bad_output", 502, /AI trả kết quả sai định dạng/],
  ])("lỗi %s hiện thông báo dễ hiểu", async (code, status, message) => {
    mockApi({
      onRequest: (method, path) =>
        method === "POST" && path === CANDIDATES ? jsonResponse({ error: code, message: "x" }, status) : undefined,
    });
    renderWithProviders(<PromptLibrary projectId="p-1" isLeader />);
    await userEvent.click(await screen.findByRole("button", { name: "Tìm prompt mẫu" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("tiêu đề, lý do, nội dung ứng viên có HTML hiển thị dạng chữ", async () => {
    mockApi({
      saved: {
        result: aiResult([{ ...candidate, title: "<img src=x onerror=alert(1)>", why: "<b>đậm</b>", prompt: "<script>alert(1)</script>" }]),
      },
    });
    renderWithProviders(<PromptLibrary projectId="p-1" isLeader />);
    expect(await screen.findByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(screen.getByText("<b>đậm</b>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });
});
