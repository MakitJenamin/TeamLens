import "server-only";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Gộp các file dịch theo namespace: messages/<locale>/<namespace>.json
 * → { [namespace]: nội dung file }. Thêm namespace mới chỉ cần thêm file JSON,
 * không phải sửa file nào khác.
 */
const cache = new Map<string, Record<string, unknown>>();

export async function loadMessages(locale: string): Promise<Record<string, unknown>> {
  // Khi dev không cache để sửa file dịch thấy ngay.
  const cached = cache.get(locale);
  if (cached && process.env.NODE_ENV === "production") return cached;

  // Đường dẫn viết tĩnh dưới "messages" để Next chỉ trace thư mục này.
  const files = (await readdir(path.join(process.cwd(), "messages", locale)))
    .filter((f) => f.endsWith(".json"))
    .sort();
  const entries = await Promise.all(
    files.map(async (file) => {
      const raw = await readFile(path.join(process.cwd(), "messages", locale, file), "utf8");
      return [path.basename(file, ".json"), JSON.parse(raw)] as const;
    }),
  );
  const messages: Record<string, unknown> = Object.fromEntries(entries);
  cache.set(locale, messages);
  return messages;
}
