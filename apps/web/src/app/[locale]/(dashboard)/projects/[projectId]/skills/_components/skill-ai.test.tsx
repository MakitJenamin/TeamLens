import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiResult, SkillClusterAiResults } from "@teamlens/schema";
import type { SkillCluster } from "@/lib/api/types";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { SkillFinder } from "./skill-finder";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
}));

const U1 = "11111111-1111-4111-8111-111111111111";
const CLUSTER_ID = "4f6c2d7e-1b3a-5c8e-9d5f-0a1b2c3d4e5f";
const AI_URL = `/api/v1/projects/p-1/skill-clusters/${CLUSTER_ID}/ai`;

const cluster: SkillCluster = {
  id: CLUSTER_ID,
  label: "Chạy pnpm test rồi sửa lỗi lint",
  count: 5,
  userCount: 1,
  firstSeenAt: "2026-11-03T08:12:00.000Z",
  lastSeenAt: "2026-11-27T15:40:00.000Z",
  users: [{ userId: U1, name: "Thành viên 1", count: 5 }],
  examples: [{ sessionId: "s-9", turnSeq: 4, ts: "2026-11-27T15:40:00.000Z", userId: U1, excerpt: "chạy test" }],
};

const MARKDOWN = '---\nname: chay-test\ndescription: "Dùng khi chạy test"\n---\n\n## Các bước\n1. Chạy test.\n';

function aiResult(kind: string, result: Record<string, unknown>): AiResult {
  return {
    kind,
    subjectType: "skill_cluster",
    subjectId: CLUSTER_ID,
    locale: "vi",
    model: "claude-test",
    promptVersion: `${kind}@1`,
    result,
    createdAt: "2026-11-28T09:00:00.000Z",
  } as AiResult;
}
const triageResult = aiResult("skill_triage", {
  verdict: "strong",
  reason: "Lặp lại cùng một quy trình.",
  suggestedName: "chay-test",
  summary: "Chạy test rồi sửa lint.",
});
const skillResult = aiResult("skill_content", {
  name: "chay-test",
  description: "Dùng khi chạy test",
  body: "## Các bước\n1. Chạy test.",
  markdown: MARKDOWN,
});

interface Routes {
  hasKey: boolean;
  saved?: SkillClusterAiResults;
  post?: (url: string, body: unknown) => Response;
}

/** Giả lập API theo đường dẫn; trả về danh sách các POST để kiểm tra. */
function mockApi({ hasKey, saved = { triage: null, skill: null }, post }: Routes) {
  const posts: { url: string; body: { locale?: string; from?: string; userId?: string } }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://x");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      posts.push({ url: url.pathname, body });
      return post ? post(url.pathname, body) : jsonResponse({}, 500);
    }
    if (url.pathname === "/api/v1/me/llm-key")
      return jsonResponse(hasKey ? { key: { provider: "anthropic", model: "claude-test" } } : { key: null });
    if (url.pathname === AI_URL) return jsonResponse(saved);
    return jsonResponse({
      range: { from: "2026-10-29T00:00:00.000Z", to: "2026-11-28T00:00:00.000Z" },
      stats: { promptsAnalyzed: 10, promptsClustered: 5, clusterCount: 1, truncated: false },
      clusters: [cluster],
    });
  });
  return posts;
}

async function openCluster() {
  renderWithProviders(<SkillFinder projectId="p-1" members={[{ id: U1, name: "Thành viên 1" }]} />);
  await userEvent.click(await screen.findByRole("button", { name: /Xem ví dụ: Chạy pnpm test/ }));
}

afterEach(() => vi.restoreAllMocks());

describe("ClusterAi (nút AI của Skill Finder)", () => {
  it("chưa có key: chỉ có link tới Cài đặt AI, không có nút", async () => {
    mockApi({ hasKey: false });
    await openCluster();
    const link = await screen.findByRole("link", { name: /Thêm API key AI/ });
    expect(link).toHaveAttribute("href", "/settings/ai");
    expect(screen.queryByRole("button", { name: "Đánh giá cụm này" })).not.toBeInTheDocument();
  });

  it("có key: bấm Đánh giá gửi POST với locale, from theo bộ lọc và hiện kết quả", async () => {
    const posts = mockApi({ hasKey: true, post: () => jsonResponse(triageResult) });
    await openCluster();
    await userEvent.click(await screen.findByRole("button", { name: "Đánh giá cụm này" }));

    const view = await screen.findByTestId("skill-triage");
    expect(within(view).getByText("Nên làm skill")).toBeInTheDocument();
    expect(within(view).getByText("chay-test")).toBeInTheDocument();
    expect(within(view).getByText("Lặp lại cùng một quy trình.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Làm lại: Đánh giá cụm này" })).toBeInTheDocument();

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`${AI_URL}/triage`);
    expect(posts[0].body.locale).toBe("vi");
    expect(posts[0].body.userId).toBeUndefined();
    const days = (Date.now() - Date.parse(posts[0].body.from ?? "")) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("lọc theo người thì gửi kèm userId", async () => {
    const posts = mockApi({ hasKey: true, post: () => jsonResponse(triageResult) });
    renderWithProviders(<SkillFinder projectId="p-1" members={[{ id: U1, name: "Thành viên 1" }]} />);
    await userEvent.selectOptions(await screen.findByLabelText("Thành viên"), U1);
    await userEvent.click(await screen.findByRole("button", { name: /Xem ví dụ: Chạy pnpm test/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Soạn SKILL.md" }));
    await screen.findByTestId("skill-content");
    expect(posts[0].url).toBe(`${AI_URL}/skill`);
    expect(posts[0].body.userId).toBe(U1);
  });

  it("Soạn SKILL.md hiện nội dung, sao chép và tải về đúng markdown", async () => {
    mockApi({ hasKey: true, post: () => jsonResponse(skillResult) });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const createObjectURL = vi.fn(() => "blob:x");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await openCluster();
    await userEvent.click(await screen.findByRole("button", { name: "Soạn SKILL.md" }));
    const view = await screen.findByTestId("skill-content");
    expect(view.querySelector("pre")?.textContent).toBe(MARKDOWN);

    await userEvent.click(within(view).getByRole("button", { name: "Sao chép" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MARKDOWN));
    expect(await within(view).findByRole("button", { name: "Đã chép" })).toBeInTheDocument();

    await userEvent.click(within(view).getByRole("button", { name: "Tải SKILL.md" }));
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(await blob.text()).toBe(MARKDOWN);
    expect(click).toHaveBeenCalledOnce();
  });

  it("hiện kết quả đã lưu khi mở cụm", async () => {
    mockApi({ hasKey: true, saved: { triage: triageResult, skill: skillResult } });
    await openCluster();
    expect(await screen.findByTestId("skill-triage")).toBeInTheDocument();
    expect(await screen.findByTestId("skill-content")).toBeInTheDocument();
  });

  it("lỗi llm_key_invalid hiện thông báo và link Cài đặt AI; lỗi lạ hiện thông báo chung", async () => {
    mockApi({
      hasKey: true,
      post: (url) =>
        url.endsWith("/triage")
          ? jsonResponse({ error: "llm_key_invalid", message: "x" }, 401)
          : jsonResponse({ error: "boom", message: "x" }, 500),
    });
    await openCluster();
    await userEvent.click(await screen.findByRole("button", { name: "Đánh giá cụm này" }));
    expect(await screen.findByText("Nhà cung cấp AI từ chối API key.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Mở Cài đặt AI" })).toHaveAttribute("href", "/settings/ai");

    await userEvent.click(screen.getByRole("button", { name: "Soạn SKILL.md" }));
    expect(await screen.findByText("Có lỗi khi chạy AI. Thử lại sau.")).toBeInTheDocument();
  });

  it("nội dung SKILL.md có HTML hiển thị dạng chữ", async () => {
    const hostile = aiResult("skill_content", {
      name: "x",
      description: "d",
      body: "b",
      markdown: "<img src=x onerror=alert(1)>",
    });
    mockApi({ hasKey: true, post: () => jsonResponse(hostile) });
    await openCluster();
    await userEvent.click(await screen.findByRole("button", { name: "Soạn SKILL.md" }));
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});
