import { screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { CliLogin } from "./cli-login";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
}));

const TICKET = "tkt_abcdefghijklmnop";

describe("CliLogin (/auth/cli)", () => {
  beforeEach(() => {
    replace.mockReset();
    refresh.mockReset();
  });

  it("đổi ticket đúng một lần (kể cả StrictMode) rồi vào dashboard", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ user: { id: "m1", email: null, name: "Bình", role: "member" } }),
    );
    renderWithProviders(
      <StrictMode>
        <CliLogin ticket={TICKET} />
      </StrictMode>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Đang đăng nhập...");

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(refresh).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/auth/ticket");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ ticket: TICKET });
  });

  it("invalid_ticket thì bảo chạy lại tl open", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "invalid_ticket", message: "hết hạn" }, 401),
    );
    renderWithProviders(<CliLogin ticket={TICKET} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Link đăng nhập đã hết hạn hoặc đã được dùng. Chạy lại lệnh tl open trên máy của bạn.",
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("thiếu ticket thì không gọi API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderWithProviders(<CliLogin ticket="" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Thiếu mã đăng nhập");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
