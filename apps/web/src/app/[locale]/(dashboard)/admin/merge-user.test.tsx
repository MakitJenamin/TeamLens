import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { User } from "@/lib/api/types";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { MergeUser, mergeTargets } from "./merge-user";

const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
const success = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (msg: string) => success(msg) } }));

const leader: User = { id: "l1", name: "Lan", email: "lan@x.vn", role: "leader" };
const leader2: User = { id: "l2", name: "Long", email: "long@x.vn", role: "leader" };
const an: User = { id: "m1", name: "An", email: null, role: "member" };
const an2: User = { id: "m2", name: "An (máy 2)", email: null, role: "member" };
const users = [leader, leader2, an, an2];

describe("mergeTargets", () => {
  it("member gộp được vào member hoặc leader, leader chỉ vào leader, không vào chính nó", () => {
    expect(mergeTargets(an2, users).map((u) => u.id)).toEqual(["l1", "l2", "m1"]);
    expect(mergeTargets(leader, users).map((u) => u.id)).toEqual(["l2"]);
    expect(mergeTargets(leader, [leader, an])).toEqual([]);
  });
});

describe("MergeUser", () => {
  it("không có đích hợp lệ thì không hiện nút", () => {
    renderWithProviders(<MergeUser user={leader} users={[leader, an]} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("chọn đích, xác nhận rồi gọi API gộp", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ user: an, moved: { devices: 1, sessions: 3, projects: 1 } }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithProviders(<MergeUser user={an2} users={users} />);

    await userEvent.click(screen.getByRole("button", { name: "Gộp vào…" }));
    await userEvent.selectOptions(screen.getByLabelText("Giữ lại tài khoản"), "m1");
    await userEvent.click(screen.getByRole("button", { name: "Gộp" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Gộp An (máy 2) vào An?"));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/users/m2/merge");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ intoUserId: "m1" });
    await vi.waitFor(() =>
      expect(success).toHaveBeenCalledWith("Đã gộp vào An."),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("hủy xác nhận thì không gọi API; lỗi API hiện thông báo", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ error: "role_mismatch", message: "Không gộp leader vào member" }, 409));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithProviders(<MergeUser user={an2} users={users} />);
    await userEvent.click(screen.getByRole("button", { name: "Gộp vào…" }));
    await userEvent.click(screen.getByRole("button", { name: "Gộp" }));
    expect(fetchMock).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Gộp" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ intoUserId: "l1" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Không gộp leader vào member");
  });
});
