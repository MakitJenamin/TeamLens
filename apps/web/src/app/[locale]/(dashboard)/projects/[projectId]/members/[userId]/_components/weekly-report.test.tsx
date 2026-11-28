import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiResult, WeeklyReportResult, WeeklyReportSaved } from "@teamlens/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import type { ProfileWeek } from "./profile-types";
import { WeeklyReportCard } from "./weekly-report";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
}));

const URL_PATH = "/api/v1/users/u-1/ai/weekly-report";

const week = (date: string, sessions: number): ProfileWeek => ({ week: date, sessions, tokens: 1000, scores: {}, teamScores: {} });
const WEEKS = [week("2026-11-09", 3), week("2026-11-16", 0), week("2026-11-23", 5), week("2026-11-02", 2)];

const report: WeeklyReportResult = {
  week: "2026-11-23",
  headline: "Tuần có tiến bộ ở context.",
  strengths: ["Context 70, tăng 10 điểm."],
  weaknesses: ["Verification 50, thấp hơn team."],
  vsLastWeek: "Từ 2 lên 5 session.",
  focus: { title: "Chạy test sau khi sửa", detail: "Chạy test trước khi kết thúc." },
  examples: [
    { sessionId: "s-1", turnSeq: 1, kind: "needs_work", excerpt: "sửa lỗi đăng nhập", comment: "Thiếu triệu chứng." },
    { sessionId: "s-2", turnSeq: 4, kind: "good", excerpt: "Thêm trang cài đặt có test", comment: "Rõ phạm vi." },
  ],
};

function aiResult(result: WeeklyReportResult = report): AiResult {
  return {
    id: "r1",
    kind: "weekly_user",
    subjectType: "user_week",
    subjectId: "w-1",
    locale: "vi",
    provider: "anthropic",
    model: "claude-test",
    promptVersion: "weekly_user@1",
    inputTokens: 1,
    outputTokens: 1,
    createdAt: "2026-11-28T09:00:00.000Z",
    result,
  } as unknown as AiResult;
}

type Body = { project?: string; week?: string; locale?: string };
interface Routes {
  hasKey?: boolean;
  saved?: WeeklyReportSaved;
  post?: (body: Body) => Response;
}

function mockApi({ hasKey = true, saved = { result: null }, post }: Routes = {}) {
  const requests: { method: string; path: string; search: string; body: Body }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://x");
    const method = init?.method ?? "GET";
    const body: Body = init?.body ? (JSON.parse(String(init.body)) as Body) : {};
    requests.push({ method, path: url.pathname, search: url.search, body });
    if (url.pathname === "/api/v1/me/llm-key")
      return jsonResponse(hasKey ? { key: { provider: "anthropic", model: "claude-test" } } : { key: null });
    if (url.pathname === URL_PATH && method === "GET") return jsonResponse(saved);
    if (url.pathname === URL_PATH && method === "POST") return post ? post(body) : jsonResponse(aiResult());
    return jsonResponse({ error: "not_found", message: "x" }, 404);
  });
  return requests;
}

const renderCard = (weeks = WEEKS) => renderWithProviders(<WeeklyReportCard projectId="p-1" userId="u-1" weeks={weeks} />);

afterEach(() => vi.restoreAllMocks());

describe("WeeklyReportCard (B1)", () => {
  it("không hiện gì khi hồ sơ chưa có tuần nào có session", () => {
    mockApi();
    const { container } = renderCard([week("2026-11-16", 0)]);
    expect(container).toBeEmptyDOMElement();
  });

  it("chưa có key: chỉ có link tới Cài đặt AI, không có nút viết", async () => {
    mockApi({ hasKey: false });
    renderCard();
    const link = await screen.findByRole("link", { name: /Thêm API key AI để viết báo cáo tuần/ });
    expect(link).toHaveAttribute("href", "/settings/ai");
    expect(screen.queryByRole("button", { name: "Viết báo cáo tuần" })).not.toBeInTheDocument();
  });

  it("chọn sẵn tuần mới nhất có session, chỉ liệt kê tuần có session, mới nhất trước", async () => {
    mockApi();
    renderCard();
    const select = await screen.findByLabelText("Tuần");
    expect(select).toHaveValue("2026-11-23");
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(["2026-11-23", "2026-11-09", "2026-11-02"]);
    expect(options[0].textContent).toContain("5 session");
  });

  it("bấm viết gửi POST với project, tuần và locale; hiện báo cáo đầy đủ với link tới đúng turn", async () => {
    const requests = mockApi();
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: "Viết báo cáo tuần" }));

    const view = await screen.findByTestId("weekly-report");
    expect(within(view).getByText("Tuần có tiến bộ ở context.")).toBeInTheDocument();
    expect(within(view).getByText("Context 70, tăng 10 điểm.")).toBeInTheDocument();
    expect(within(view).getByText("Verification 50, thấp hơn team.")).toBeInTheDocument();
    expect(within(view).getByText("Từ 2 lên 5 session.")).toBeInTheDocument();
    expect(within(screen.getByTestId("weekly-focus")).getByText(/Chạy test sau khi sửa/)).toBeInTheDocument();
    expect(within(view).getByText("Cần cải thiện", { selector: '[data-slot="badge"]' })).toBeInTheDocument();
    expect(within(view).getByText("Làm tốt")).toBeInTheDocument();
    expect(within(view).getByRole("link", { name: "Mở turn #4" })).toHaveAttribute("href", "/projects/p-1/sessions/s-2#turn-4");
    expect(screen.getByRole("button", { name: "Viết lại" })).toBeInTheDocument();

    const post = requests.find((r) => r.method === "POST");
    expect(post?.body).toEqual({ project: "p-1", week: "2026-11-23", locale: "vi" });
  });

  it("hiện báo cáo đã lưu của tuần đang chọn và tải lại khi đổi tuần", async () => {
    const requests = mockApi({ saved: { result: aiResult() } });
    renderCard();
    expect(await screen.findByTestId("weekly-report")).toBeInTheDocument();
    expect(requests.find((r) => r.method === "GET" && r.path === URL_PATH)?.search).toContain("week=2026-11-23");

    await userEvent.selectOptions(screen.getByLabelText("Tuần"), "2026-11-09");
    await waitFor(() => expect(requests.at(-1)?.search).toContain("week=2026-11-09"));
  });

  it.each([
    ["no_week_data", 409, /chưa có session nào trong tuần đã chọn/],
    ["llm_key_invalid", 422, /Nhà cung cấp AI từ chối API key/],
    ["validation_error", 400, /Tuần đã chọn không hợp lệ/],
    ["llm_bad_output", 502, /AI trả kết quả sai định dạng/],
  ])("lỗi %s hiện thông báo dễ hiểu", async (code, status, message) => {
    mockApi({ post: () => jsonResponse({ error: code, message: "x" }, status) });
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: "Viết báo cáo tuần" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("nội dung báo cáo có HTML hiển thị dạng chữ", async () => {
    mockApi({
      saved: {
        result: aiResult({
          ...report,
          headline: "<img src=x onerror=alert(1)>",
          strengths: ["<b>đậm</b>"],
          examples: [{ ...report.examples[0], excerpt: "<script>alert(1)</script>", comment: "<i>nghiêng</i>" }],
        }),
      },
    });
    renderCard();
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(screen.getByText("<b>đậm</b>")).toBeInTheDocument();
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(screen.getByText("<i>nghiêng</i>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });
});
