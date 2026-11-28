import { describe, expect, it } from "vitest";
import { leaderboardRange } from "./leaderboard-range";

describe("leaderboardRange", () => {
  it("ngày cuối là ngày trước mốc kết thúc không gồm, theo UTC", () => {
    expect(leaderboardRange("2026-11-23T00:00:00.000Z", "2026-11-30T00:00:00.000Z")).toEqual({ from: "2026-11-23", to: "2026-11-29" });
    expect(leaderboardRange("2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(leaderboardRange("2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});
