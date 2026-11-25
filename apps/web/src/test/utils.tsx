import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextIntlClientProvider } from "next-intl";

/** Đọc file dịch đồng bộ cho test (giống loader thật: mỗi file một namespace). */
export function readMessages(locale: string): Record<string, unknown> {
  const dir = path.join(process.cwd(), "messages", locale);
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => [path.basename(f, ".json"), JSON.parse(readFileSync(path.join(dir, f), "utf8"))]),
  );
}

export function renderWithProviders(
  ui: React.ReactElement,
  { locale = "vi", ...options }: RenderOptions & { locale?: string } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <NextIntlClientProvider locale={locale} messages={readMessages(locale)} timeZone="Asia/Ho_Chi_Minh">
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </NextIntlClientProvider>,
    options,
  );
}

/** Tạo Response JSON giả cho fetch. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
