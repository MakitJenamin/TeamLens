import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchInvitePreview } from "@/lib/api/server";
import { renderWithProviders } from "@/test/utils";
import InvitePage from "./page";

vi.mock("@/lib/api/server", () => ({ fetchInvitePreview: vi.fn() }));
vi.mock("next-intl/server", async () => {
  const { createFormatter, createTranslator } = await import("next-intl");
  const { readMessages } = await import("@/test/utils");
  const messages = readMessages("vi");
  return {
    setRequestLocale: vi.fn(),
    getTranslations: async (ns: string | { namespace: string }) =>
      createTranslator({
        locale: "vi",
        messages,
        namespace: (typeof ns === "string" ? ns : ns.namespace) as "invite",
      }),
    getFormatter: async () => createFormatter({ locale: "vi", timeZone: "Asia/Ho_Chi_Minh" }),
  };
});

const CODE = "Zm9vYmFyYmF6cXV4";
const props = { params: Promise.resolve({ locale: "vi", code: CODE }) };

async function renderPage() {
  renderWithProviders(await InvitePage(props as never));
}

describe("trang /i/[code]", () => {
  beforeEach(() => vi.mocked(fetchInvitePreview).mockReset());

  it("hiện project, repo và hai câu lệnh tham gia theo serverUrl", async () => {
    vi.mocked(fetchInvitePreview).mockResolvedValue({
      ok: true,
      preview: {
        serverUrl: "https://lens.acme.dev/",
        project: { id: "p1", name: "Đội Web", slug: "doi-web" },
        repoPatterns: ["github.com/acme/*"],
        consent: { version: "2026-11-26", text: "..." },
        expiresAt: "2026-12-04T03:00:00Z",
      },
    });
    await renderPage();

    expect(fetchInvitePreview).toHaveBeenCalledWith(CODE);
    expect(screen.getByText("Tham gia Đội Web")).toBeInTheDocument();
    expect(screen.getByText("github.com/acme/*")).toBeInTheDocument();
    expect(
      screen.getByText(`irm https://lens.acme.dev/install.ps1?code=${CODE} | iex`),
    ).toBeInTheDocument();
    expect(screen.getByText(`tl join https://lens.acme.dev/i/${CODE}`)).toBeInTheDocument();
    // Không có form đăng nhập/đăng ký.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/mật khẩu/i)).not.toBeInTheDocument();
  });

  it.each([
    ["invite_expired", "Link mời đã hết hạn. Hãy xin leader link mới."],
    ["invite_revoked", "Link mời đã bị thu hồi. Hãy xin leader link mới."],
    ["invite_used_up", "Link mời đã hết lượt dùng. Hãy xin leader link mới."],
    ["invite_not_found", "Link mời không đúng. Hãy xin leader link mới."],
    ["network_error", "Không kiểm tra được link mời lúc này. Thử tải lại trang sau ít phút."],
  ])("lỗi %s thì báo xin link mới, không hiện câu lệnh", async (error, message) => {
    vi.mocked(fetchInvitePreview).mockResolvedValue({ ok: false, error });
    await renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText(/tl join/)).not.toBeInTheDocument();
  });
});
