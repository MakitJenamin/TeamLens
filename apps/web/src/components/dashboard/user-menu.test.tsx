import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { initials, UserMenu } from "./user-menu";

const replace = vi.fn();
const refresh = vi.fn();
const push = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace, refresh, push }),
}));

const user = {
  id: "u1",
  email: "member1@teamlens.local",
  name: "Member Một",
  role: "member" as const,
};

describe("initials", () => {
  it("lấy chữ đầu của từ đầu và cuối", () => {
    expect(initials("Nguyễn Văn An", "a@b.c")).toBe("NA");
    expect(initials("", "member1@teamlens.local")).toBe("ME");
  });
});

describe("UserMenu", () => {
  beforeEach(() => {
    replace.mockReset();
    refresh.mockReset();
  });

  it("đăng xuất gọi API rồi về /login bằng router có locale", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(undefined, 204));
    renderWithProviders(
      <SidebarProvider>
        <UserMenu user={user} />
      </SidebarProvider>,
      { locale: "en" },
    );

    await userEvent.click(screen.getByRole("button", { name: /Member Một/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(refresh).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/logout");
  });
});
