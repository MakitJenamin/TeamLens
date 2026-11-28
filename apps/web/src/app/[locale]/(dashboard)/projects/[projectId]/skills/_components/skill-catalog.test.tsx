import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiResult, CatalogPicksSaved, SkillCatalogSource } from "@teamlens/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillClusterList } from "@/lib/api/types";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { SkillFinder } from "./skill-finder";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
}));

const U1 = "11111111-1111-4111-8111-111111111111";
const PICKS_URL = "/api/v1/projects/p-1/ai/catalog-picks";

const SOURCES: SkillCatalogSource[] = [
  { id: "a1", url: "https://github.com/anthropics/skills", kind: "github", enabled: true, createdAt: "2026-11-01T00:00:00.000Z" },
  { id: "a2", url: "https://github.com/github/awesome-copilot", kind: "github", enabled: false, createdAt: "2026-11-01T00:00:01.000Z" },
];

const picksResult: AiResult = {
  id: "r1",
  kind: "catalog_picks",
  subjectType: "project",
  subjectId: "p-1",
  locale: "vi",
  provider: "anthropic",
  model: "claude-test",
  promptVersion: "catalog_picks@1",
  inputTokens: 1,
  outputTokens: 1,
  createdAt: "2026-11-28T09:00:00.000Z",
  result: {
    candidatesConsidered: 42,
    picks: [
      {
        name: "lint-fixer",
        description: "Run tests and fix lint errors.",
        sourceUrl: "https://github.com/acme/skills",
        skillUrl: "https://github.com/acme/skills/blob/HEAD/skills/lint-fixer/SKILL.md",
        reason: "Việc chạy test rồi sửa lint được gõ 9 lần bởi 3 người.",
      },
    ],
  },
} as AiResult;

const emptyList: SkillClusterList = {
  range: { from: "2026-10-29T00:00:00.000Z", to: "2026-11-28T00:00:00.000Z" },
  stats: { promptsAnalyzed: 0, promptsClustered: 0, clusterCount: 0, truncated: false },
  clusters: [],
};

type ReqBody = { url?: string; enabled?: boolean; locale?: string; userId?: string; from?: string };

interface Routes {
  hasKey?: boolean;
  saved?: CatalogPicksSaved;
  sources?: SkillCatalogSource[];
  onRequest?: (method: string, path: string, body: ReqBody) => Response | undefined;
}

function mockApi({ hasKey = true, saved = { result: null }, sources = SOURCES, onRequest }: Routes = {}) {
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
    if (url.pathname === PICKS_URL && method === "GET") return jsonResponse(saved);
    if (url.pathname === "/api/v1/skill-catalog-sources" && method === "GET") return jsonResponse({ sources });
    return jsonResponse(emptyList);
  });
  return requests;
}

function renderFinder(members: { id: string; name: string }[] | null) {
  return renderWithProviders(<SkillFinder projectId="p-1" members={members} />);
}

afterEach(() => vi.restoreAllMocks());

describe("CatalogSection (gợi ý skill có sẵn, S3)", () => {
  it("chưa có key: chỉ có link tới Cài đặt AI, không có nút chạy", async () => {
    mockApi({ hasKey: false });
    renderFinder(null);
    const link = await screen.findByRole("link", { name: /Thêm API key AI để nhận gợi ý/ });
    expect(link).toHaveAttribute("href", "/settings/ai");
    expect(screen.queryByRole("button", { name: "Gợi ý skill có sẵn" })).not.toBeInTheDocument();
  });

  it("bấm chạy gửi POST với locale và from theo bộ lọc, hiện gợi ý có link và lý do", async () => {
    const requests = mockApi({
      onRequest: (method, path) => (method === "POST" && path === PICKS_URL ? jsonResponse(picksResult) : undefined),
    });
    renderFinder([{ id: U1, name: "Thành viên 1" }]);
    await userEvent.selectOptions(await screen.findByLabelText("Thành viên"), U1);
    await userEvent.click(await screen.findByRole("button", { name: "Gợi ý skill có sẵn" }));

    const view = await screen.findByTestId("catalog-picks");
    const link = within(view).getByRole("link", { name: /lint-fixer/ });
    expect(link).toHaveAttribute("href", "https://github.com/acme/skills/blob/HEAD/skills/lint-fixer/SKILL.md");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(link).toHaveAttribute("target", "_blank");
    expect(within(view).getByText("acme/skills")).toBeInTheDocument();
    expect(within(view).getByText("Việc chạy test rồi sửa lint được gõ 9 lần bởi 3 người.")).toBeInTheDocument();
    expect(within(view).getByText(/Đã xét 42 skill/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Làm lại: Gợi ý skill có sẵn" })).toBeInTheDocument();

    const post = requests.find((r) => r.method === "POST");
    expect(post?.path).toBe(PICKS_URL);
    expect(post?.body.locale).toBe("vi");
    expect(post?.body.userId).toBe(U1);
    const days = (Date.now() - Date.parse(post?.body.from ?? "")) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("hiện kết quả đã lưu; kết quả rỗng nói chưa có skill nào hợp", async () => {
    mockApi({ saved: { result: picksResult } });
    const first = renderFinder(null);
    expect(await screen.findByTestId("catalog-picks")).toBeInTheDocument();
    first.unmount();

    vi.restoreAllMocks();
    mockApi({ saved: { result: { ...picksResult, result: { picks: [], candidatesConsidered: 7 } } as AiResult } });
    renderFinder(null);
    expect(await screen.findByText(/Trong 7 skill đã xét, chưa có skill nào hợp rõ ràng/)).toBeInTheDocument();
  });

  it.each([
    ["no_clusters", 409, /Chưa có việc nào lặp lại đủ 3 lần/],
    ["catalog_unavailable", 502, /Không đọc được catalog skill/],
    ["llm_key_invalid", 422, /Nhà cung cấp AI từ chối API key/],
  ])("lỗi %s hiện thông báo dễ hiểu", async (code, status, message) => {
    mockApi({
      onRequest: (method, path) =>
        method === "POST" && path === PICKS_URL ? jsonResponse({ error: code, message: "x" }, status) : undefined,
    });
    renderFinder(null);
    await userEvent.click(await screen.findByRole("button", { name: "Gợi ý skill có sẵn" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  describe("nguồn catalog", () => {
    it("member chỉ xem: không có nút thêm, bật tắt, xóa; nguồn chỉ tải khi mở", async () => {
      const requests = mockApi();
      renderFinder(null);
      await userEvent.click(await screen.findByRole("button", { name: "Nguồn catalog" }));
      expect(await screen.findByText("anthropics/skills")).toBeInTheDocument();
      expect(screen.getByText("github/awesome-copilot")).toBeInTheDocument();
      expect(screen.getByText("Đang tắt")).toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Xóa nguồn/ })).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Thêm nguồn/)).not.toBeInTheDocument();
      expect(requests.filter((r) => r.path === "/api/v1/skill-catalog-sources")).toHaveLength(1);
    });

    it("leader bật tắt, xóa và thêm nguồn", async () => {
      let sources = [...SOURCES];
      const requests = mockApi({
        onRequest: (method, path, body) => {
          if (path === "/api/v1/skill-catalog-sources" && method === "GET") return jsonResponse({ sources });
          if (path === "/api/v1/skill-catalog-sources" && method === "POST") {
            const created: SkillCatalogSource = { id: "a3", url: body.url ?? "", kind: "github", enabled: true, createdAt: "2026-11-28T00:00:00.000Z" };
            sources = [...sources, created];
            return jsonResponse(created, 201);
          }
          if (path === "/api/v1/skill-catalog-sources/a2" && method === "PATCH") {
            sources = sources.map((s) => (s.id === "a2" ? { ...s, enabled: body.enabled ?? false } : s));
            return jsonResponse(sources[1]);
          }
          if (path === "/api/v1/skill-catalog-sources/a1" && method === "DELETE") {
            sources = sources.filter((s) => s.id !== "a1");
            return new Response(null, { status: 204 });
          }
          return undefined;
        },
      });
      renderFinder([{ id: U1, name: "Thành viên 1" }]);
      await userEvent.click(await screen.findByRole("button", { name: "Nguồn catalog" }));
      await screen.findByText("anthropics/skills");

      const [, second] = screen.getAllByRole("checkbox");
      expect(second).not.toBeChecked();
      await userEvent.click(second);
      await waitFor(() => expect(requests.some((r) => r.method === "PATCH" && r.body.enabled === true)).toBe(true));
      await waitFor(() => expect(screen.getAllByRole("checkbox")[1]).toBeChecked());

      await userEvent.click(screen.getByRole("button", { name: "Xóa nguồn anthropics/skills" }));
      await waitFor(() => expect(screen.queryByText("anthropics/skills")).not.toBeInTheDocument());

      await userEvent.type(screen.getByLabelText(/Thêm nguồn/), "  https://github.com/acme/skills  ");
      await userEvent.click(screen.getByRole("button", { name: "Thêm" }));
      expect(await screen.findByText("acme/skills")).toBeInTheDocument();
      expect(requests.find((r) => r.method === "POST")?.body).toEqual({ url: "https://github.com/acme/skills" });
      expect(screen.getByLabelText(/Thêm nguồn/)).toHaveValue("");
    });

    it("thêm URL sai hoặc trùng thì báo lỗi đúng", async () => {
      mockApi({
        onRequest: (method, path, body) =>
          method === "POST" && path === "/api/v1/skill-catalog-sources"
            ? (body.url ?? "").includes("evil")
              ? jsonResponse({ error: "validation_error", message: "x" }, 400)
              : jsonResponse({ error: "source_exists", message: "x" }, 409)
            : undefined,
      });
      renderFinder([{ id: U1, name: "Thành viên 1" }]);
      await userEvent.click(await screen.findByRole("button", { name: "Nguồn catalog" }));
      const input = await screen.findByLabelText(/Thêm nguồn/);
      await userEvent.type(input, "https://evil.com/a/b");
      await userEvent.click(screen.getByRole("button", { name: "Thêm" }));
      expect(await screen.findByText(/Chỉ nhận URL repo GitHub công khai/)).toBeInTheDocument();
      await userEvent.clear(input);
      await userEvent.type(input, "https://github.com/a/b");
      await userEvent.click(screen.getByRole("button", { name: "Thêm" }));
      expect(await screen.findByText("Nguồn này đã có.")).toBeInTheDocument();
    });
  });

  it("tên, mô tả và lý do có HTML hiển thị dạng chữ", async () => {
    const hostile = {
      ...picksResult,
      result: {
        candidatesConsidered: 1,
        picks: [
          {
            name: "<img src=x onerror=alert(1)>",
            description: "<script>alert(1)</script>",
            sourceUrl: "https://github.com/acme/skills",
            skillUrl: "https://github.com/acme/skills/blob/HEAD/x/SKILL.md",
            reason: "<b>đậm</b>",
          },
        ],
      },
    } as AiResult;
    mockApi({ saved: { result: hostile } });
    renderFinder(null);
    expect(await screen.findByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(screen.getByText("<b>đậm</b>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });
});
