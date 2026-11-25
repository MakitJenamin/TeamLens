import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { LoginForm } from "./login-form";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
}));

describe("LoginForm", () => {
  beforeEach(() => {
    replace.mockReset();
    refresh.mockReset();
  });

  it("báo lỗi khi email không hợp lệ và không gọi API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderWithProviders(<LoginForm />);

    await userEvent.type(screen.getByLabelText("Email"), "khong-phai-email");
    await userEvent.type(screen.getByLabelText("Mật khẩu"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));

    expect(await screen.findByText("Email không hợp lệ.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("đăng nhập thành công thì chuyển tới ?next=", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ user: { id: "1", email: "admin@teamlens.local", name: "Admin", isAdmin: true } }),
      );
    renderWithProviders(<LoginForm next="/device?code=ABCD-EFGH" />);

    await userEvent.type(screen.getByLabelText("Email"), "admin@teamlens.local");
    await userEvent.type(screen.getByLabelText("Mật khẩu"), "teamlens123");
    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/device?code=ABCD-EFGH"));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/auth/login");
    expect(JSON.parse(String(init?.body))).toEqual({
      email: "admin@teamlens.local",
      password: "teamlens123",
    });
  });

  it("sai mật khẩu thì hiện thông báo", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "invalid_credentials", message: "Sai" }, 401),
    );
    renderWithProviders(<LoginForm />);

    await userEvent.type(screen.getByLabelText("Email"), "admin@teamlens.local");
    await userEvent.type(screen.getByLabelText("Mật khẩu"), "sai");
    await userEvent.click(screen.getByRole("button", { name: "Đăng nhập" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Email hoặc mật khẩu không đúng.");
    expect(replace).not.toHaveBeenCalled();
  });
});
