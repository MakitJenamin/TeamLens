import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ProjectSummary, User } from "@/lib/api/types";
import { renderWithProviders } from "@/test/utils";
import { AppSidebar } from "./app-sidebar";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p-2" }),
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
  usePathname: () => "/projects/p-2/sessions/s-1",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const projects: ProjectSummary[] = [
  { id: "p-1", name: "TeamLens", slug: "teamlens", isMember: true },
  { id: "p-2", name: "Demo", slug: "demo", isMember: true },
];

function renderSidebar(user: User) {
  return renderWithProviders(
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar user={user} projects={projects} />
      </SidebarProvider>
    </TooltipProvider>,
  );
}

const member: User = {
  id: "u1",
  email: "member1@teamlens.local",
  name: "Member Một",
  role: "member",
};

describe("AppSidebar", () => {
  it("có đủ link theo project đang chọn và đánh dấu link active", () => {
    renderSidebar(member);

    const expected: Record<string, string> = {
      "Tổng quan": "/projects/p-2/overview",
      "Thành viên": "/projects/p-2/members",
      Session: "/projects/p-2/sessions",
      "Skill Finder": "/projects/p-2/skills",
      "Thư viện prompt": "/projects/p-2/prompt-library",
      Leaderboard: "/projects/p-2/leaderboard",
      Rule: "/projects/p-2/rules",
      "Của tôi": "/me",
      "Cài đặt AI": "/settings/ai",
    };
    for (const [label, href] of Object.entries(expected)) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
    // Trang chi tiết session → link "Session" active.
    expect(screen.getByRole("link", { name: "Session" })).toHaveAttribute("data-active");
    expect(screen.getByRole("link", { name: "Tổng quan" })).not.toHaveAttribute("data-active");
    expect(screen.getByText("Demo")).toBeInTheDocument();
  });

  it("ẩn link Quản trị với người không phải admin", () => {
    renderSidebar(member);
    expect(screen.queryByRole("link", { name: "Quản trị" })).not.toBeInTheDocument();
  });

  it("hiện link Quản trị với leader", () => {
    renderSidebar({ ...member, role: "leader" });
    expect(screen.getByRole("link", { name: "Quản trị" })).toHaveAttribute("href", "/admin");
  });
});
