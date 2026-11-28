import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiResult, TeamReportResult, TeamReportSaved } from "@teamlens/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import type { OverviewWeek } from "./overview-types";
import { TeamReportCard } from "./team-report";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
}));

const PATH = "/api/v1/projects/p-1/ai/weekly-report";

const week = (date: string, sessions: number): OverviewWeek => ({
  week: date,
  sessions,
  tokens: 1000,
  estimatedCostUsd: null,
  scores: {},
});
const WEEKS = [week("2026-11-09", 12), week("2026-11-16", 0), week("2026-11-23", 20), week("2026-11-02", 7)];

const report: TeamReportResult = {
  week: "2026-11-23",
  headline: "Tuần có nhiều session hơn, verification vẫn thấp.",
  vsLastWeek: "Từ 15 lên 20 session.",
  topIssues: [
    { ruleKey: "no-test-after-edit", category: "verification", severity: "high", count: 9, memberCount: 3, comment: "Thiếu chạy test sau khi sửa." },
  ],
  improved: [{ userId: "u-1", name: "An Nguyễn", change: 12, comment: "Điểm tổng tăng rõ." }],
  sharingSession: { topic: "Chạy test sau khi sửa", detail: "Demo quy trình chạy test." },
};

function aiResult(result: TeamReportResult = report): AiResult {
  return {
    id: "r1",
    kind: "weekly_team",
    subjectType: "project_week",
    subjectId: "w-1",
    locale: "vi",
    provider: "anthropic",
    model: "claude-test",
    promptVersion: "weekly_team@1",
    inputTokens: 1,
    outputTokens: 1,
    createdAt: "2026-11-28T09:00:00.000Z",
    result,
  } as unknown as AiResult;
}

type Body = { week?: string; locale?: string };
interface Routes {
  hasKey?: boolean;
  saved?: TeamReportSaved;
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
    if (url.pathname === PATH && method === "GET") return jsonResponse(saved);
    if (url.pathname === PATH && method === "POST") return post ? post(body) : jsonResponse(aiResult());
    return jsonResponse({ error: "not_found", message: "x" }, 404);
  });
  return requests;
}

const renderCard = (weeks = WEEKS) => renderWithProviders(<TeamReportCard projectId="p-1" weeks={weeks} />);

afterEach(() => vi.restoreAllMocks());

describe("TeamReportCard (B2)", () => {
  it("không hiện gì khi chưa có tuần nào có session", () => {
    mockApi();
    const { container } = renderCard([week("2026-11-16", 0)]);
    expect(container).toBeEmptyDOMElement();
  });

  it("chưa có key: chỉ có link tới Cài đặt AI, không có nút viết", async () => {
    mockApi({ hasKey: false });
    renderCard();
    const link = await screen.findByRole("link", { name: /Thêm API key AI để viết báo cáo tuần của team/ });
    expect(link).toHaveAttribute("href", "/settings/ai");
    expect(screen.queryByRole("button", { name: "Viết báo cáo tuần" })).not.toBeInTheDocument();
  });

  it("chọn sẵn tuần mới nhất có session, chỉ liệt kê tuần có session, mới nhất trước", async () => {
    mockApi();
    renderCard();
    const select = await screen.findByLabelText("Tuần");
    expect(select).toHaveValue("2026-11-23");
    const values = within(select)
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["2026-11-23", "2026-11-09", "2026-11-02"]);
  });

  it("bấm viết gửi POST với tuần và locale, hiện lỗi phổ biến, người tiến bộ và gợi ý buổi chia sẻ", async () => {
    const requests = mockApi();
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: "Viết báo cáo tuần" }));

    const view = await screen.findByTestId("team-report");
    expect(within(view).getByText("Tuần có nhiều session hơn, verification vẫn thấp.")).toBeInTheDocument();
    expect(within(view).getByText("Từ 15 lên 20 session.")).toBeInTheDocument();
    expect(within(view).getByText("no-test-after-edit")).toBeInTheDocument();
    expect(within(view).getByText("Cao")).toBeInTheDocument();
    expect(within(view).getByText("9 lần, 3 người")).toBeInTheDocument();
    expect(within(view).getByText("Thiếu chạy test sau khi sửa.")).toBeInTheDocument();
    expect(within(view).getByText("An Nguyễn")).toBeInTheDocument();
    expect(within(view).getByText("+12 điểm")).toBeInTheDocument();
    expect(within(screen.getByTestId("team-sharing")).getByText(/Chạy test sau khi sửa/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Viết lại" })).toBeInTheDocument();

    expect(requests.find((r) => r.method === "POST")?.body).toEqual({ week: "2026-11-23", locale: "vi" });
  });

  it("không có người tiến bộ thì không hiện mục đó; change null thì không hiện điểm", async () => {
    mockApi({ saved: { result: aiResult({ ...report, improved: [] }) } });
    const first = renderCard();
    expect(await screen.findByTestId("team-report")).toBeInTheDocument();
    expect(screen.queryByText("Tiến bộ trong tuần")).not.toBeInTheDocument();
    first.unmount();

    vi.restoreAllMocks();
    mockApi({ saved: { result: aiResult({ ...report, improved: [{ ...report.improved[0], change: null }] }) } });
    renderCard();
    expect(await screen.findByText("An Nguyễn")).toBeInTheDocument();
    expect(screen.queryByText(/điểm$/)).not.toBeInTheDocument();
  });

  it("hiện báo cáo đã lưu và tải lại khi đổi tuần", async () => {
    const requests = mockApi({ saved: { result: aiResult() } });
    renderCard();
    expect(await screen.findByTestId("team-report")).toBeInTheDocument();
    expect(requests.find((r) => r.method === "GET" && r.path === PATH)?.search).toContain("week=2026-11-23");
    await userEvent.selectOptions(screen.getByLabelText("Tuần"), "2026-11-09");
    await waitFor(() => expect(requests.at(-1)?.search).toContain("week=2026-11-09"));
  });

  it.each([
    ["no_week_data", 409, /Project chưa có session nào trong tuần đã chọn/],
    ["llm_key_invalid", 422, /Nhà cung cấp AI từ chối API key/],
    ["forbidden", 403, /Chỉ leader mới viết được báo cáo/],
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
          improved: [{ userId: "u-1", name: "<b>Tên</b>", change: 1, comment: "<script>alert(1)</script>" }],
        }),
      },
    });
    renderCard();
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(screen.getByText("<b>Tên</b>")).toBeInTheDocument();
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });
});
