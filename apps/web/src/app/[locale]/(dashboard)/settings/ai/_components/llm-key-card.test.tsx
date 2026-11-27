import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, renderWithProviders } from "@/test/utils";
import { LlmKeyCard } from "./llm-key-card";

const savedKey = {
  provider: "openai_compatible",
  baseUrl: "http://localhost:11434/v1",
  model: "qwen2.5:3b",
  keyHint: "…a1B2",
  createdAt: "2026-11-27T00:00:00Z",
  updatedAt: "2026-11-27T01:00:00Z",
};

type Handler = (body: unknown) => Response;

/** Mock fetch theo method + path, ghi lại body đã gửi. */
function mockApi(routes: Record<string, Handler>) {
  const bodies: Record<string, unknown[]> = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const handler = routes[key];
    if (!handler) throw new Error("Không mock: " + key);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    (bodies[key] ??= []).push(body);
    return handler(body);
  });
  return bodies;
}

afterEach(() => vi.restoreAllMocks());

describe("LlmKeyCard", () => {
  it("chưa có key: chọn OpenAI-compatible, key để trống, Kiểm tra rồi Lưu", async () => {
    const u = userEvent.setup();
    const bodies = mockApi({
      "GET /api/v1/me/llm-key": () => jsonResponse({ key: null }),
      "POST /api/v1/me/llm-key/test": () =>
        jsonResponse({ ok: true, provider: "openai_compatible", model: "qwen2.5:3b", latencyMs: 812 }),
      "PUT /api/v1/me/llm-key": () => jsonResponse({ key: { ...savedKey, keyHint: "" } }),
    });
    renderWithProviders(<LlmKeyCard />);

    expect(await screen.findByText(/Chưa có key/)).toBeInTheDocument();
    // Anthropic mặc định: không có ô base URL.
    expect(screen.queryByLabelText(/Base URL/)).not.toBeInTheDocument();

    await u.click(screen.getByRole("radio", { name: /OpenAI-compatible/ }));
    await u.type(screen.getByLabelText(/Base URL/), "http://localhost:11434/v1");
    await u.type(screen.getByLabelText(/^Model/), "qwen2.5:3b");
    expect(screen.getByText(/Có thể để trống/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^API key/)).toHaveAttribute("type", "password");

    await u.click(screen.getByRole("button", { name: "Kiểm tra" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Kết nối được qwen2.5:3b (OpenAI-compatible) sau 812 ms.",
    );
    expect(bodies["POST /api/v1/me/llm-key/test"][0]).toEqual({
      provider: "openai_compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5:3b",
      apiKey: "",
    });

    await u.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(bodies["PUT /api/v1/me/llm-key"]).toHaveLength(1));
    expect(bodies["PUT /api/v1/me/llm-key"][0]).toEqual({
      provider: "openai_compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5:3b",
      apiKey: "",
    });
    // Sau khi lưu: có nút Xóa key, không còn dòng "Chưa có key".
    expect(await screen.findByRole("button", { name: "Xóa key" })).toBeInTheDocument();
    expect(screen.queryByText(/Chưa có key/)).not.toBeInTheDocument();
  });

  it("Anthropic chưa có key mà để trống key: báo lỗi, không gọi API", async () => {
    const u = userEvent.setup();
    const bodies = mockApi({ "GET /api/v1/me/llm-key": () => jsonResponse({ key: null }) });
    renderWithProviders(<LlmKeyCard />);
    await u.type(await screen.findByLabelText(/^Model/), "claude-sonnet-4-5");
    await u.click(screen.getByRole("button", { name: "Kiểm tra" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Cần nhập API key.");
    expect(Object.keys(bodies)).toEqual(["GET /api/v1/me/llm-key"]);
  });

  it("đã có key: hiện keyHint, để trống key = giữ key cũ, lỗi Kiểm tra hiện theo mã llm_*", async () => {
    const u = userEvent.setup();
    const bodies = mockApi({
      "GET /api/v1/me/llm-key": () => jsonResponse({ key: savedKey }),
      "POST /api/v1/me/llm-key/test": () =>
        jsonResponse({ error: "llm_model_not_found", message: "Model không tồn tại" }, 422),
      "PUT /api/v1/me/llm-key": () => jsonResponse({ key: { ...savedKey, model: "llama3" } }),
    });
    renderWithProviders(<LlmKeyCard />);

    expect(await screen.findByText("Đã lưu key …a1B2. Để trống để giữ key cũ.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Base URL/)).toHaveValue("http://localhost:11434/v1");
    expect(screen.getByLabelText(/^API key/)).toHaveValue("");

    await u.click(screen.getByRole("button", { name: "Kiểm tra" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Provider không có model này. Kiểm tra lại tên model.",
    );
    // Không gửi apiKey: server dùng key đã lưu.
    expect(bodies["POST /api/v1/me/llm-key/test"][0]).not.toHaveProperty("apiKey");

    const model = screen.getByLabelText(/^Model/);
    await u.clear(model);
    await u.type(model, "llama3");
    await u.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(bodies["PUT /api/v1/me/llm-key"]).toHaveLength(1));
    expect(bodies["PUT /api/v1/me/llm-key"][0]).toEqual({
      provider: "openai_compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });
  });

  it("Xóa key phải xác nhận bằng dialog", async () => {
    const u = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    const bodies = mockApi({
      "GET /api/v1/me/llm-key": () => jsonResponse({ key: savedKey }),
      "DELETE /api/v1/me/llm-key": () => new Response(null, { status: 204 }),
    });
    renderWithProviders(<LlmKeyCard />);

    await u.click(await screen.findByRole("button", { name: "Xóa key" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Xóa API key?");
    await u.click(screen.getByRole("button", { name: "Hủy" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(bodies["DELETE /api/v1/me/llm-key"]).toBeUndefined();

    await u.click(screen.getByRole("button", { name: "Xóa key" }));
    const again = await screen.findByRole("alertdialog");
    await u.click(
      [...again.querySelectorAll("button")].find((b) => b.textContent === "Xóa key") as HTMLElement,
    );
    await waitFor(() => expect(bodies["DELETE /api/v1/me/llm-key"]).toHaveLength(1));
    expect(await screen.findByText(/Chưa có key/)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
