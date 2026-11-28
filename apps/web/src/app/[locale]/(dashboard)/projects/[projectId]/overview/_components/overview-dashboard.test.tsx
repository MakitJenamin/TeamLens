import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import type { ProjectOverview } from "./overview-types";
import { OverviewDashboard } from "./overview-dashboard";

// Recharts cần kích thước thật của DOM; các biểu đồ có bảng số liệu đi kèm nên test kiểm tra bảng.
vi.mock("./weekly-charts", () => ({
  TokensChart: () => <div data-testid="tokens-chart" />,
  ScoresChart: () => <div data-testid="scores-chart" />,
}));

const overview: ProjectOverview = {
  range: { from: "2026-11-02T00:00:00.000Z", to: "2026-11-16T00:00:00.000Z" },
  totals: { sessions: 36, activeMembers: 2, tokens: 4_820_000, estimatedCostUsd: 31.4 },
  weeks: [
    {
      week: "2026-11-02",
      sessions: 18,
      tokens: 2_400_000,
      estimatedCostUsd: 15.2,
      scores: {
        prompt_quality: 74,
        context: 80,
        correction_loop: 68,
        session_management: 85,
        verification: 60,
      },
    },
    { week: "2026-11-09", sessions: 18, tokens: 2_420_000, estimatedCostUsd: null, scores: {} },
  ],
  byAgent: [
    { agent: "claude_code", sessions: 30, tokens: 4_100_000 },
    { agent: "codex", sessions: 6, tokens: 720_000 },
  ],
  byModel: [
    { model: "claude-opus-4-6", turns: 410, tokens: 3_900_000, estimatedCostUsd: 28.9 },
    { model: "model-la", turns: 20, tokens: 100_000, estimatedCostUsd: null },
    { model: null, turns: 12, tokens: 90_000, estimatedCostUsd: null },
  ],
  workTypes: [
    { workType: "bugfix", sessions: 20 },
    { workType: "feature", sessions: 10 },
    { workType: null, sessions: 6 },
  ],
  usageStats: { cacheHitRate: 0.62, premiumModelRate: 0.8, highReasoningRate: null, avgOutputTokensPerTurn: 540 },
  topFindings: [
    { ruleKey: "no-test-after-edit", category: "verification", severity: "high", count: 15, memberCount: 2 },
    { ruleKey: "lazy-prompting", category: "prompt_quality", severity: "medium", count: 4, memberCount: 1 },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe("OverviewDashboard", () => {
  it("hiện số tổng, bảng theo tuần, phân bố, số liệu tham khảo và top anti-pattern", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(overview));
    renderWithProviders(<OverviewDashboard projectId="p-1" />);

    expect(await screen.findByText("Chi phí ước tính", { selector: '[data-slot="card-description"]' })).toBeInTheDocument();
    expect(screen.getByText("36")).toBeInTheDocument();
    expect(screen.getByText(/31,4/)).toBeInTheDocument();
    expect(screen.getByTestId("tokens-chart")).toBeInTheDocument();
    expect(screen.getByTestId("scores-chart")).toBeInTheDocument();

    // Gọi đúng endpoint, mặc định 8 tuần.
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/v1/projects/p-1/overview?from=");

    // Bảng theo tuần: tuần có điểm hiện số, tuần chưa chấm hiện dấu gạch.
    const weekly = screen.getByRole("table", { name: /Số liệu theo tuần/ });
    const rows = within(weekly).getAllByRole("row");
    expect(within(rows[1]).getByText("74")).toBeInTheDocument();
    expect(within(rows[2]).getAllByText("—").length).toBeGreaterThanOrEqual(6);

    // Phân bố agent và model; model chưa có giá được ghi rõ.
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("claude-opus-4-6")).toBeInTheDocument();
    expect(screen.getByText("Không rõ model")).toBeInTheDocument();
    expect(screen.getByText("Chưa có giá")).toBeInTheDocument();

    // Số liệu tham khảo; giá trị thiếu hiện dấu gạch.
    expect(screen.getByRole("heading", { name: "Số liệu tham khảo" })).toBeInTheDocument();
    expect(screen.getByText("62%")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();

    // Anti-pattern kèm mức độ bằng chữ, không chỉ bằng màu.
    expect(screen.getByText("no-test-after-edit")).toBeInTheDocument();
    expect(screen.getByText("Cao")).toBeInTheDocument();
    expect(screen.getByText("15 lần")).toBeInTheDocument();
    expect(screen.getByText("2 thành viên")).toBeInTheDocument();
  });

  it("thẻ theo loại việc: nhãn, số session, phần trăm, chưa phân loại; rỗng thì báo chưa có dữ liệu", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(overview));
    const first = renderWithProviders(<OverviewDashboard projectId="p-1" />);
    const card = await screen.findByTestId("work-types");
    expect(within(card).getByText("Sửa lỗi")).toBeInTheDocument();
    expect(within(card).getByText(/20 · 56%/)).toBeInTheDocument();
    expect(within(card).getByText("Tính năng")).toBeInTheDocument();
    expect(within(card).getByText("Chưa phân loại")).toBeInTheDocument();
    expect(within(card).getByText(/6 · 17%/)).toBeInTheDocument();
    first.unmount();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ...overview, workTypes: [] }));
    renderWithProviders(<OverviewDashboard projectId="p-1" />);
    expect(within(await screen.findByTestId("work-types")).getByText("Chưa có dữ liệu")).toBeInTheDocument();
  });

  it("đổi số tuần thì gọi lại API với mốc from khác", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(overview));
    renderWithProviders(<OverviewDashboard projectId="p-1" />);
    await screen.findByText("36");

    await userEvent.selectOptions(screen.getByLabelText("Khoảng thời gian"), "26");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).not.toBe(String(fetchMock.mock.calls[0][0]));
  });

  it("chưa có dữ liệu thì hiện trạng thái trống, không vẽ biểu đồ", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ...overview,
        totals: { sessions: 0, activeMembers: 0, tokens: 0, estimatedCostUsd: null },
      }),
    );
    renderWithProviders(<OverviewDashboard projectId="p-1" />);

    expect(await screen.findByText("Chưa có dữ liệu trong khoảng này")).toBeInTheDocument();
    expect(screen.queryByTestId("tokens-chart")).not.toBeInTheDocument();
  });

  it("chi phí null thì hiện dấu gạch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...overview, totals: { ...overview.totals, estimatedCostUsd: null } }),
    );
    renderWithProviders(<OverviewDashboard projectId="p-1" />);

    const [costLabel] = await screen.findAllByText("Chi phí ước tính");
    const costCard = costLabel.closest<HTMLElement>('[data-slot="card"]');
    expect(costCard).not.toBeNull();
    expect(within(costCard!).getByText("—")).toBeInTheDocument();
  });

  it("lỗi API thì hiện thông báo lỗi", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "forbidden", message: "Bạn không có quyền thực hiện thao tác này" }, 403),
    );
    renderWithProviders(<OverviewDashboard projectId="p-1" />);

    expect(await screen.findByText("Không tải được tổng quan project")).toBeInTheDocument();
    expect(screen.getByText("Bạn không có quyền thực hiện thao tác này")).toBeInTheDocument();
  });
});
