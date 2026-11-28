import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { User } from "@/lib/api/types";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { EraseUser } from "./erase-user";

const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
const success = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (msg: string) => success(msg) } }));

const an: User = { id: "m1", name: "An", email: null, role: "member" };

describe("EraseUser", () => {
  it("không hiện nút cho chính mình", () => {
    renderWithProviders(<EraseUser user={an} currentUserId="m1" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("phải gõ đúng tên mới bật nút xóa, xóa xong làm mới danh sách", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ userId: "m1", sessions: 3, devices: 1 }));
    const confirm = vi.spyOn(window, "confirm");
    renderWithProviders(<EraseUser user={an} currentUserId="l1" />);

    await userEvent.click(screen.getByRole("button", { name: "Xóa dữ liệu" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Xóa toàn bộ dữ liệu của An? Không hoàn tác được.");
    const submit = screen.getAllByRole("button", { name: "Xóa dữ liệu" }).at(-1)!;
    expect(submit).toBeDisabled();

    const input = screen.getByLabelText("Gõ tên để xác nhận");
    await userEvent.type(input, "Ann");
    expect(submit).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "An");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/admin/users/m1");
    expect(init?.method).toBe("DELETE");
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith("Đã xóa dữ liệu của An."));
    expect(refresh).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("lỗi API hiện trong hộp thoại", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "last_leader", message: "Đây là leader cuối cùng" }, 409),
    );
    renderWithProviders(<EraseUser user={an} currentUserId="l1" />);
    await userEvent.click(screen.getByRole("button", { name: "Xóa dữ liệu" }));
    await userEvent.type(await screen.findByLabelText("Gõ tên để xác nhận"), "An{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Đây là leader cuối cùng");
  });
});
