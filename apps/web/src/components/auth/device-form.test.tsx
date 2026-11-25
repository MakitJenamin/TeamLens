import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { DeviceForm, isValidUserCode, normalizeUserCode } from "./device-form";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string } & React.ComponentProps<"a">) => <a href={href} {...props} />,
}));

describe("normalizeUserCode", () => {
  it("viết hoa và chèn dấu gạch", () => {
    expect(normalizeUserCode("bcdf ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("bcd")).toBe("BCD");
    expect(normalizeUserCode("BCDF-GHJK-XX")).toBe("BCDF-GHJK");
  });
  it("chỉ chấp nhận bảng chữ của contract", () => {
    expect(isValidUserCode("BCDF-GHJK")).toBe(true);
    expect(isValidUserCode("ABCD-EFGH")).toBe(false); // A, E không có trong bảng chữ
  });
});

describe("DeviceForm", () => {
  it("điền sẵn mã từ ?code= và hiện thành công", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ device: { id: "d1", name: "LAPTOP-TAI" } }));
    renderWithProviders(<DeviceForm initialCode="wdjb-mjht" />);

    expect(screen.getByLabelText("Mã thiết bị")).toHaveValue("WDJB-MJHT");
    await userEvent.click(screen.getByRole("button", { name: "Cho phép thiết bị" }));

    expect(await screen.findByText("Đã kết nối thiết bị")).toBeInTheDocument();
    expect(screen.getByText(/LAPTOP-TAI/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/device/approve");
    expect(JSON.parse(String(init?.body))).toEqual({ userCode: "WDJB-MJHT" });
  });

  it("mã hết hạn (410)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "expired_code", message: "Hết hạn" }, 410),
    );
    renderWithProviders(<DeviceForm initialCode="WDJB-MJHT" />);
    await userEvent.click(screen.getByRole("button", { name: "Cho phép thiết bị" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Mã đã hết hạn");
  });

  it("sai mã (404)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "invalid_code", message: "Sai" }, 404),
    );
    renderWithProviders(<DeviceForm initialCode="WDJB-MJHT" />, { locale: "en" });
    await userEvent.click(screen.getByRole("button", { name: "Allow device" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid code");
  });

  it("mã sai định dạng thì không gọi API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderWithProviders(<DeviceForm initialCode="ABCD-EFGH" />);
    await userEvent.click(screen.getByRole("button", { name: "Cho phép thiết bị" }));
    expect(await screen.findByText("Mã phải có dạng XXXX-XXXX.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
