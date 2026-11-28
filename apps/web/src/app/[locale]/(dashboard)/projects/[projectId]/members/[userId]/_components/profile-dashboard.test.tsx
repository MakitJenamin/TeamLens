import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionPage, SessionSummary } from "@/lib/api/types";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import type { MemberProfile } from "./profile-types";
import { ProfileDashboard } from "./profile-dashboard";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
}));
// Recharts cần kích thước thật của DOM; hồ sơ có bảng số liệu đi kèm nên test kiểm tra bảng.
vi.mock("./profile-radar", () => ({ ProfileRadar: () => <div data-testid="profile-radar" /> }));
vi.mock("../../../overview/_components/weekly-charts", () => ({
  ScoresChart: () => <div data-testid="scores-chart" />,
  TokensChart: () => <div data-testid="tokens-chart" />,
}));

const scores = {
  prompt_quality: 85,
  context: 99,
  correction_loop: 71,
  session_management: 92,
  verification: 60,
};
const teamScores = {
  prompt_quality: 90,
  context: 99,
  correction_loop: 80,
  session_management: 95,
  verification: 78,
};

const profile: MemberProfile = {
  user: { id: "u-1", name: "Thành viên 1" },
  projectId: "p-1",
  range: { from: "2026-11-09T00:00:00.000Z", to: "2026-11-23T00:00:00.000Z" },
  totals: { sessions: 12, tokens: 19_400 },
  scores,
  teamScores,
  weeks: [
    { week: "2026-11-09", sessions: 6, tokens: 9_700, scores, teamScores },
    { week: "2026-11-16", sessions: 6, tokens: 9_700, scores: {}, teamScores: {} },
  ],
  patterns: [
    {
      ruleKey: "lazy-prompting",
      category: "prompt_quality",
      severity: "medium",
      count: 4,
      advice: "Bổ sung mục tiêu và ngữ cảnh.",
      examples: [
        { sessionId: "s-1", turnSeq: 3, message: "12/30 prompt trong tuần quá ngắn.", excerpt: "fix" },
        { sessionId: "s-2", turnSeq: null, message: "Session quá dài.", excerpt: null },
      ],
    },
    { ruleKey: "no-test-after-edit", category: "verification", severity: "high", count: 2, advice: null, examples: [] },
  ],
};

function summary(id: string): SessionSummary {
  return {
    id,
    projectId: "p-1",
    user: { id: "u-1", email: null, name: "Thành viên 1" },
    agent: "claude_code",
    agentVersion: "2.1.4",
    model: "claude-opus-4-6",
    repoRemote: "github.com/acme/app",
    branch: "feat/x",
    cwdRelative: "",
    startedAt: "2026-11-20T01:00:00.000Z",
    endedAt: "2026-11-20T01:05:00.000Z",
    turnCount: 6,
    usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 },
    title: `Prompt ${id}`,
    parentSessionId: null,
    childCount: 0,
    permissionMode: null,
    workType: null,
  };
}

function mockApi(body: MemberProfile | Response = profile, sessions: SessionSummary[] = [summary("rs-1")]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/profile")) return body instanceof Response ? body.clone() : jsonResponse(body);
    return jsonResponse({ items: sessions, nextCursor: null } satisfies SessionPage);
  });
}

afterEach(() => vi.restoreAllMocks());

describe("ProfileDashboard", () => {
  it("hiện số tổng, radar, bảng tuần kèm trung bình team, anti-pattern có ví dụ và lời khuyên", async () => {
    const fetchMock = mockApi();
    renderWithProviders(<ProfileDashboard projectId="p-1" userId="u-1" />);

    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText(/19,4/)).toBeInTheDocument();
    expect(screen.getByTestId("profile-radar")).toBeInTheDocument();
    expect(screen.getByTestId("scores-chart")).toBeInTheDocument();

    // Gọi đúng endpoint, mặc định 2 tuần.
    const url = String(fetchMock.mock.calls.find(([u]) => String(u).includes("/profile"))![0]);
    expect(url).toContain("/api/v1/users/u-1/profile?project=p-1&from=");
    expect(screen.getByLabelText("Khoảng thời gian")).toHaveValue("2");

    // Bảng tuần: điểm của thành viên kèm trung bình team; tuần chưa chấm hiện dấu gạch.
    const table = screen.getByRole("table", { name: /Số liệu theo tuần/ });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]).getByText("85")).toBeInTheDocument();
    expect(within(rows[1]).getByText("team 90")).toBeInTheDocument();
    expect(within(rows[2]).getAllByText("—")).toHaveLength(5);

    // Anti-pattern: mức độ bằng chữ, lời khuyên, ví dụ kèm link tới đúng session và turn.
    expect(screen.getByText("lazy-prompting")).toBeInTheDocument();
    expect(screen.getByText("Trung bình")).toBeInTheDocument();
    expect(screen.getByText("4 lần")).toBeInTheDocument();
    expect(screen.getByText("Bổ sung mục tiêu và ngữ cảnh.")).toBeInTheDocument();
    expect(screen.getByText("fix")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Xem session (turn 3)" })).toHaveAttribute(
      "href",
      "/projects/p-1/sessions/s-1",
    );
    // Ví dụ không có đoạn trích (turn không có văn bản hoặc đã hết hạn lưu): vẫn còn nhận xét và link.
    expect(screen.getByText(/Không có đoạn trích/)).toBeInTheDocument();
    expect(screen.getByText("Session quá dài.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Xem session" })).toHaveAttribute("href", "/projects/p-1/sessions/s-2");
    expect(screen.getByText("Cao")).toBeInTheDocument();

    // 5 session gần nhất lấy từ API session theo userId.
    expect(await screen.findByText("Prompt rs-1")).toBeInTheDocument();
    const sessionsUrl = String(fetchMock.mock.calls.find(([u]) => String(u).includes("/sessions"))![0]);
    expect(sessionsUrl).toContain("/api/v1/projects/p-1/sessions?userId=u-1&limit=5");
    expect(screen.getByRole("link", { name: "Xem tất cả session" })).toHaveAttribute(
      "href",
      "/projects/p-1/sessions",
    );
  });

  it("đổi số tuần thì gọi lại API hồ sơ với mốc from khác", async () => {
    const fetchMock = mockApi();
    renderWithProviders(<ProfileDashboard projectId="p-1" userId="u-1" />);
    await screen.findByText("12");

    await userEvent.selectOptions(screen.getByLabelText("Khoảng thời gian"), "8");
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/profile"))).toHaveLength(2),
    );
    const [first, second] = fetchMock.mock.calls.filter(([u]) => String(u).includes("/profile")).map(([u]) => String(u));
    expect(second).not.toBe(first);
  });

  it("chưa có điểm nào thì hiện thông báo thay cho radar", async () => {
    mockApi({ ...profile, scores: {}, teamScores: {} });
    renderWithProviders(<ProfileDashboard projectId="p-1" userId="u-1" />);

    expect(await screen.findByText("Chưa có session được chấm.")).toBeInTheDocument();
    expect(screen.queryByTestId("profile-radar")).not.toBeInTheDocument();
  });

  it("chưa có dữ liệu thì hiện trạng thái trống nhưng vẫn có mục session gần nhất", async () => {
    mockApi(
      { ...profile, totals: { sessions: 0, tokens: 0 }, scores: {}, teamScores: {}, patterns: [] },
      [],
    );
    renderWithProviders(<ProfileDashboard projectId="p-1" userId="u-1" />);

    expect(await screen.findByText("Chưa có dữ liệu trong khoảng này")).toBeInTheDocument();
    expect(screen.queryByTestId("profile-radar")).not.toBeInTheDocument();
    expect(await screen.findByText("Chưa có session nào.")).toBeInTheDocument();
  });

  it("không có anti-pattern thì hiện câu thông báo", async () => {
    mockApi({ ...profile, patterns: [] });
    renderWithProviders(<ProfileDashboard projectId="p-1" userId="u-1" />);

    expect(await screen.findByText("Chưa có anti-pattern.")).toBeInTheDocument();
  });

  it("lỗi API thì hiện thông báo lỗi", async () => {
    mockApi(jsonResponse({ error: "forbidden", message: "Bạn không có quyền thực hiện thao tác này" }, 403));
    renderWithProviders(<ProfileDashboard projectId="p-1" userId="u-1" />);

    expect(await screen.findByText("Không tải được hồ sơ thành viên")).toBeInTheDocument();
    expect(screen.getByText("Bạn không có quyền thực hiện thao tác này")).toBeInTheDocument();
  });
});
