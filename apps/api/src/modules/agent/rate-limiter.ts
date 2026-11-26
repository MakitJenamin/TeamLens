/** Giới hạn ingest: 60 request/phút mỗi thiết bị (spec 7.3). */
export const INGEST_LIMIT_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

/**
 * Đếm request theo cửa sổ cố định 1 phút, giữ trong bộ nhớ của tiến trình.
 * MVP chạy một instance API nên đủ; chạy nhiều instance thì cần chuyển sang Postgres.
 * Không dùng `@Injectable()`: AgentModule tạo bằng factory (tham số `now` để test).
 */
export class IngestRateLimiter {
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  /** Trả về số giây cần chờ nếu vượt giới hạn, `null` nếu được phép. */
  hit(deviceId: string, limit = INGEST_LIMIT_PER_MINUTE): number | null {
    const now = this.now();
    let w = this.windows.get(deviceId);
    if (!w || now - w.start >= WINDOW_MS) {
      w = { start: now, count: 0 };
      this.windows.set(deviceId, w);
      this.prune(now);
    }
    w.count += 1;
    if (w.count <= limit) return null;
    return Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000));
  }

  private prune(now: number): void {
    if (this.windows.size < 1000) return;
    for (const [key, w] of this.windows) {
      if (now - w.start >= WINDOW_MS) this.windows.delete(key);
    }
  }
}
