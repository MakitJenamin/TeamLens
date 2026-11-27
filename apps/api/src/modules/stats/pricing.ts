/** Số token của một lượt (hoặc tổng nhiều lượt). */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Giá USD cho mỗi 1 triệu token. */
interface ModelPrice {
  /** Tên model bắt đầu bằng chuỗi này thì dùng giá này; chuỗi dài hơn được ưu tiên. */
  prefix: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Model cao cấp, dùng cho số liệu "tỉ lệ dùng model cao cấp" (không tính điểm). */
  premium: boolean;
}

/**
 * Bảng giá THAM KHẢO để ước tính chi phí trên trang Tổng quan (M2.9). Đây không phải hóa đơn:
 * nhà cung cấp đổi giá thì sửa ở đây. Model chưa có trong bảng không được tính vào chi phí.
 * Claude: cache đọc = 0,1 lần giá input, cache ghi (5 phút) = 1,25 lần; dòng Opus là giá từ Opus 4.5.
 * OpenAI/Codex: cache đọc = 0,125 lần giá input, không tính tiền cache ghi.
 */
const MODEL_PRICES: readonly ModelPrice[] = [
  {
    prefix: 'claude-opus',
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    premium: true,
  },
  {
    prefix: 'claude-sonnet',
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    premium: false,
  },
  {
    prefix: 'claude-haiku',
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    premium: false,
  },
  {
    prefix: 'gpt-5-pro',
    input: 15,
    output: 120,
    cacheRead: 0,
    cacheWrite: 0,
    premium: true,
  },
  {
    prefix: 'gpt-5',
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: 0,
    premium: false,
  },
]
  .slice()
  .sort((a, b) => b.prefix.length - a.prefix.length);

function findPrice(model: string | null): ModelPrice | undefined {
  if (!model) return undefined;
  const name = model.toLowerCase();
  return MODEL_PRICES.find((price) => name.startsWith(price.prefix));
}

/** Chi phí ước tính (USD) của `tokens` chạy bằng `model`; `null` khi model chưa có giá. */
export function estimateCostUsd(
  model: string | null,
  tokens: TokenCounts,
): number | null {
  const price = findPrice(model);
  if (!price) return null;
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

/** Model cao cấp theo bảng giá; model lạ hoặc không rõ thì không tính là cao cấp. */
export function isPremiumModel(model: string | null): boolean {
  return findPrice(model)?.premium ?? false;
}
