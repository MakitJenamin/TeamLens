/**
 * Khoảng ngày hiển thị của bảng xếp hạng. API trả `to` là mốc kết thúc không gồm (thứ Hai kế tiếp,
 * ngày 1 tháng sau, 00:00 UTC), nên ngày cuối hiển thị là `to` lùi một ngày, tính theo UTC.
 */
export function leaderboardRange(from: string, to: string): { from: string; to: string } {
  const last = new Date(new Date(to).getTime() - 86_400_000);
  return { from: new Date(from).toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}
