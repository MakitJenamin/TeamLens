import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Device, MemberStatus } from "@teamlens/schema";
import type { User } from "@/lib/api/types";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { deviceBadge, isRecentJoin } from "./device-status";
import { MembersPanel } from "./members-panel";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const success = vi.fn();
const failure = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (msg: string) => success(msg), error: (msg: string) => failure(msg) },
}));

afterEach(() => vi.restoreAllMocks());

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const device = (patch: Partial<Device> = {}): Device => ({
  id: "d1",
  name: "LAPTOP-AN",
  os: "windows",
  cliVersion: "0.1.0",
  status: "online",
  lastSeenAt: ago(5 * 60_000),
  createdAt: ago(10 * DAY),
  revokedAt: null,
  ...patch,
});

describe("deviceBadge", () => {
  it("map trạng thái hiệu lực và thời gian offline", () => {
    expect(deviceBadge(device(), NOW).key).toBe("online");
    expect(deviceBadge(device({ status: "paused" }), NOW).key).toBe("paused");
    expect(deviceBadge(device({ status: "consent_revoked" }), NOW).key).toBe("consentRevoked");
    expect(deviceBadge(device({ status: "online", revokedAt: ago(DAY) }), NOW).key).toBe("revoked");
    expect(deviceBadge(device({ status: "offline", lastSeenAt: null }), NOW).key).toBe("neverSeen");
    expect(deviceBadge(device({ status: "offline", lastSeenAt: ago(40 * 60_000) }), NOW).key).toBe(
      "offlineRecent",
    );
    expect(deviceBadge(device({ status: "offline", lastSeenAt: ago(5.5 * HOUR) }), NOW)).toEqual({
      key: "offlineHours",
      variant: "outline",
      count: 5,
    });
    expect(deviceBadge(device({ status: "offline", lastSeenAt: ago(3.2 * DAY) }), NOW)).toEqual({
      key: "offlineDays",
      variant: "outline",
      count: 3,
    });
  });

  it("người mới tham gia là trong 7 ngày", () => {
    expect(isRecentJoin(ago(6.9 * DAY), NOW)).toBe(true);
    expect(isRecentJoin(ago(7.1 * DAY), NOW)).toBe(false);
  });
});

const leader: MemberStatus = {
  userId: "l1",
  name: "Lan",
  email: "lan@x.vn",
  role: "leader",
  joinedAt: ago(60 * DAY),
  lastSessionAt: null,
  devices: [],
};
const an: MemberStatus = {
  userId: "m1",
  name: "An",
  email: null,
  role: "member",
  joinedAt: ago(30 * DAY),
  lastSessionAt: ago(2 * DAY),
  devices: [
    device({ id: "d-on", name: "AN-ON" }),
    device({ id: "d-off", name: "AN-OFF", status: "offline", lastSeenAt: ago(3 * DAY) }),
    device({ id: "d-pause", name: "AN-PAUSE", status: "paused" }),
    device({ id: "d-rev", name: "AN-REV", revokedAt: ago(DAY) }),
  ],
};
const binh: MemberStatus = {
  userId: "m2",
  name: "Bình",
  email: null,
  role: "member",
  joinedAt: ago(2 * DAY),
  lastSessionAt: null,
  devices: [
    device({ id: "d-consent", name: "BINH-1", status: "consent_revoked" }),
    device({ id: "d-never", name: "BINH-2", status: "offline", lastSeenAt: null }),
  ],
};
const users: User[] = [
  { id: "l1", name: "Lan", email: "lan@x.vn", role: "leader" },
  { id: "m1", name: "An", email: null, role: "member" },
  { id: "m2", name: "Bình", email: null, role: "member" },
];

function renderPanel() {
  return renderWithProviders(
    <MembersPanel
      projectId="p1"
      currentUserId="l1"
      initialData={{ items: [binh, an, leader] }}
      users={users}
    />,
  );
}

describe("MembersPanel", () => {
  it("hiện người mới tham gia, trạng thái thiết bị, link hồ sơ", () => {
    renderPanel();
    const recent = screen.getByRole("list", { name: "Mới tham gia (7 ngày)" });
    expect(within(recent).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Bình"),
    ]);

    const anCard = screen.getByLabelText("An", { selector: "[id='member-m1']" });
    expect(within(anCard).getByRole("link", { name: "An" })).toHaveAttribute("href", "/projects/p1/members/m1");
    expect(within(anCard).getByText(/Session gần nhất/)).toBeInTheDocument();
    expect(within(anCard).getByText("3/4 thiết bị chưa thu hồi")).toBeInTheDocument();
    const badge = (name: string) => screen.getByRole("listitem", { name });
    expect(badge("AN-ON")).toHaveTextContent("Đang chạy");
    expect(badge("AN-OFF")).toHaveTextContent("Offline 3 ngày");
    expect(badge("AN-PAUSE")).toHaveTextContent("Tạm dừng");
    expect(badge("AN-REV")).toHaveTextContent("Đã thu hồi");
    expect(within(screen.getByRole("listitem", { name: "AN-REV" })).queryByRole("button")).toBeNull();
    expect(badge("BINH-1")).toHaveTextContent("Đã rút đồng ý");
    expect(badge("BINH-2")).toHaveTextContent("Chưa từng kết nối");

    // Leader đang đăng nhập không có nút tự xóa mình; mỗi member có "Gộp vào…".
    const lanCard = screen.getByLabelText("Lan", { selector: "[id='member-l1']" });
    expect(within(lanCard).queryByRole("button", { name: "Xóa khỏi project" })).toBeNull();
    expect(within(lanCard).getByText("Chưa có thiết bị nào.")).toBeInTheDocument();
    expect(within(anCard).getByRole("button", { name: "Gộp vào…" })).toBeInTheDocument();
  });

  it("thu hồi thiết bị sau khi xác nhận rồi tải lại danh sách", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValue(jsonResponse({ items: [binh, an, leader] }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    renderPanel();
    const row = screen.getByRole("listitem", { name: "AN-ON" });

    await userEvent.click(within(row).getByRole("button", { name: "Thu hồi" }));
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.click(within(row).getByRole("button", { name: "Thu hồi" }));
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("Thu hồi thiết bị AN-ON?"));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/devices/d-on/revoke");
    expect(init?.method).toBe("POST");
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith("Đã thu hồi thiết bị AN-ON."));
    await vi.waitFor(() => expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/projects/p1/member-status"));
  });

  it("xóa thành viên khỏi project sau khi xác nhận; lỗi API hiện thông báo", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ error: "forbidden", message: "Không có quyền" }, 403));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPanel();
    const binhCard = screen.getByLabelText("Bình", { selector: "[id='member-m2']" });
    await userEvent.click(within(binhCard).getByRole("button", { name: "Xóa khỏi project" }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/projects/p1/members/m2");
    expect(init?.method).toBe("DELETE");
    await vi.waitFor(() => expect(failure).toHaveBeenCalledWith("Không có quyền"));
  });
});
