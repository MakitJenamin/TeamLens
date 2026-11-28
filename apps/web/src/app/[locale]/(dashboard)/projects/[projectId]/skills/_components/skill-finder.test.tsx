import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SkillCluster, SkillClusterList } from "@/lib/api/types";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { SkillFinder } from "./skill-finder";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
}));

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

function cluster(overrides: Partial<SkillCluster> = {}): SkillCluster {
  return {
    id: "4f6c2d7e-1b3a-5c8e-9d5f-0a1b2c3d4e5f",
    label: "Chạy pnpm test rồi sửa lỗi lint trong file này",
    count: 9,
    userCount: 2,
    firstSeenAt: "2026-11-03T08:12:00.000Z",
    lastSeenAt: "2026-11-27T15:40:00.000Z",
    users: [
      { userId: U1, name: "Thành viên 1", count: 6 },
      { userId: U2, name: "Thành viên 2", count: 3 },
    ],
    examples: [
      {
        sessionId: "s-9",
        turnSeq: 4,
        ts: "2026-11-27T15:40:00.000Z",
        userId: U1,
        excerpt: "Chạy pnpm test rồi sửa lỗi lint trong file src/cart.ts",
      },
      {
        sessionId: "s-3",
        turnSeq: 12,
        ts: "2026-11-20T09:00:00.000Z",
        userId: U2,
        excerpt: "chạy pnpm test và sửa lỗi lint",
      },
    ],
    ...overrides,
  };
}

function list(clusters: SkillCluster[], stats: Partial<SkillClusterList["stats"]> = {}): SkillClusterList {
  return {
    range: { from: "2026-10-29T00:00:00.000Z", to: "2026-11-28T00:00:00.000Z" },
    stats: { promptsAnalyzed: 412, promptsClustered: 31, clusterCount: clusters.length, truncated: false, ...stats },
    clusters,
  };
}

describe("SkillFinder", () => {
  it("hiện tóm tắt, ghi chú gần đúng và bảng cụm với số lần, người gõ", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(list([cluster()])));
    renderWithProviders(<SkillFinder projectId="p-1" members={[{ id: U1, name: "Thành viên 1" }]} />);

    expect(await screen.findByText(/Đã xét 412 prompt: 31 prompt nằm trong 1 cụm/)).toBeInTheDocument();
    expect(screen.getByText(/chỉ là gần đúng/)).toBeInTheDocument();
    expect(screen.getByText("Chạy pnpm test rồi sửa lỗi lint trong file này")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText("Thành viên 1, Thành viên 2")).toBeInTheDocument();
  });

  it("gọi API với limit, from theo số ngày mặc định 30; đổi khoảng và người thì gửi lại tham số", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(list([])));
    renderWithProviders(<SkillFinder projectId="p-1" members={[{ id: U2, name: "Thành viên 2" }]} />);
    await screen.findByText("Chưa có prompt nào lặp lại đủ 3 lần");

    const first = new URL(String(fetchMock.mock.calls[0][0]), "http://x");
    expect(first.pathname).toBe("/api/v1/projects/p-1/skill-clusters");
    expect(first.searchParams.get("limit")).toBe("50");
    const days = (Date.now() - Date.parse(first.searchParams.get("from") ?? "")) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(first.searchParams.has("userId")).toBe(false);

    await userEvent.selectOptions(screen.getByLabelText("Khoảng thời gian"), "90");
    await userEvent.selectOptions(screen.getByLabelText("Thành viên"), U2);
    await waitFor(() => {
      const url = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), "http://x");
      expect(url.searchParams.get("userId")).toBe(U2);
      const d = (Date.now() - Date.parse(url.searchParams.get("from") ?? "")) / 86_400_000;
      expect(d).toBeGreaterThan(89.9);
      expect(d).toBeLessThan(90.1);
    });
  });

  it("member (members = null) không có bộ lọc người và không có cột người gõ", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(list([cluster({ userCount: 1, users: [{ userId: U1, name: "Tôi", count: 9 }] })])));
    renderWithProviders(<SkillFinder projectId="p-1" members={null} />);

    await screen.findByText("Chạy pnpm test rồi sửa lỗi lint trong file này");
    expect(screen.queryByLabelText("Thành viên")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Người gõ" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Khoảng thời gian")).toBeInTheDocument();
  });

  it("bấm vào cụm mở ví dụ với link tới đúng turn, bấm lại thì ẩn", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(list([cluster()])));
    renderWithProviders(<SkillFinder projectId="p-1" members={[{ id: U1, name: "Thành viên 1" }]} />);

    const toggle = await screen.findByRole("button", { name: /Xem ví dụ: Chạy pnpm test/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "")!;
    expect(within(panel).getByText("Các lần xuất hiện gần nhất")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Turn #4" })).toHaveAttribute("href", "/projects/p-1/sessions/s-9#turn-4");
    expect(within(panel).getByRole("link", { name: "Turn #12" })).toHaveAttribute("href", "/projects/p-1/sessions/s-3#turn-12");
    expect(within(panel).getByText("Chạy pnpm test rồi sửa lỗi lint trong file src/cart.ts")).toBeInTheDocument();
    expect(within(panel).getByText("Thành viên 2")).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")).toBeNull();
  });

  it("nội dung prompt có HTML hiển thị dạng chữ, không thành phần tử", async () => {
    const hostile = cluster({
      label: "Sửa lỗi <img src=x onerror=alert(1)> trong form đăng nhập",
      examples: [
        { sessionId: "s-1", turnSeq: 1, ts: "2026-11-27T15:40:00.000Z", userId: U1, excerpt: "<script>alert(1)</script> sửa lỗi" },
      ],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(list([hostile])));
    renderWithProviders(<SkillFinder projectId="p-1" members={[{ id: U1, name: "Thành viên 1" }]} />);

    await userEvent.click(await screen.findByRole("button", { name: /Xem ví dụ/ }));
    expect(screen.getByText("<script>alert(1)</script> sửa lỗi")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });

  it("báo khi chỉ xét các prompt mới nhất (truncated)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(list([cluster()], { truncated: true })));
    renderWithProviders(<SkillFinder projectId="p-1" members={null} />);
    expect(await screen.findByText(/hơn 20\.000 prompt/)).toBeInTheDocument();
  });

  it("trạng thái rỗng và lỗi", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(list([])));
    const { unmount } = renderWithProviders(<SkillFinder projectId="p-1" members={null} />);
    expect(await screen.findByText("Chưa có prompt nào lặp lại đủ 3 lần")).toBeInTheDocument();
    expect(screen.getByText("Thử mở rộng khoảng thời gian.")).toBeInTheDocument();
    unmount();

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "forbidden", message: "Bạn không có quyền thực hiện thao tác này" }, 403));
    renderWithProviders(<SkillFinder projectId="p-1" members={null} />);
    expect(await screen.findByText("Không tải được Skill Finder")).toBeInTheDocument();
    expect(screen.getByText("Bạn không có quyền thực hiện thao tác này")).toBeInTheDocument();
  });
});
