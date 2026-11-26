import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { SetupForm } from "./setup-form";

// Điều hướng phải đi qua router có locale của next-intl (@/i18n/navigation).
const replace = vi.fn();
const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
}));

async function fillAndSubmit() {
  await userEvent.type(screen.getByLabelText("Họ tên"), "Quản trị viên");
  await userEvent.type(screen.getByLabelText("Email"), "admin@teamlens.local");
  await userEvent.type(screen.getByLabelText("Mật khẩu"), "teamlens123");
  await userEvent.type(screen.getByLabelText("Nhập lại mật khẩu"), "teamlens123");
  await userEvent.click(screen.getByRole("button", { name: "Tạo tài khoản admin" }));
}

describe("SetupForm", () => {
  beforeEach(() => {
    replace.mockReset();
    refresh.mockReset();
  });

  it("tạo admin xong thì chuyển về trang chủ bằng router có locale", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ user: { id: "1", email: "admin@teamlens.local", name: "Quản trị viên", role: "leader" } }, 201),
      );
    renderWithProviders(<SetupForm />);
    await fillAndSubmit();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(refresh).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/setup");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Quản trị viên",
      email: "admin@teamlens.local",
      password: "teamlens123",
    });
  });

  it("409 already_setup thì hiện thông báo và link đăng nhập", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "already_setup", message: "Đã thiết lập" }, 409),
    );
    renderWithProviders(<SetupForm />);
    await fillAndSubmit();

    expect(await screen.findByText("Máy chủ đã được thiết lập. Hãy đăng nhập.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tới trang đăng nhập" })).toHaveAttribute("href", "/login");
    expect(replace).not.toHaveBeenCalled();
  });
});
