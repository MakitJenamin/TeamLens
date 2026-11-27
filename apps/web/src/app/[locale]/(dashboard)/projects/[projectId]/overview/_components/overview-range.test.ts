import { describe, expect, it } from "vitest";
import { barPercent, rangeFrom } from "./overview-range";

describe("rangeFrom", () => {
  // 2026-11-12 là thứ Năm; thứ Hai của tuần đó là 2026-11-09.
  const now = new Date("2026-11-12T10:30:00Z");

  it("một tuần: chính thứ Hai của tuần hiện tại", () => {
    expect(rangeFrom(1, now)).toBe("2026-11-09T00:00:00.000Z");
  });

  it("8 tuần: lùi 7 tuần so với thứ Hai hiện tại", () => {
    expect(rangeFrom(8, now)).toBe("2026-09-21T00:00:00.000Z");
  });

  it("đúng thứ Hai và Chủ nhật vẫn rơi vào cùng tuần", () => {
    expect(rangeFrom(1, new Date("2026-11-09T00:00:00Z"))).toBe("2026-11-09T00:00:00.000Z");
    expect(rangeFrom(1, new Date("2026-11-15T23:59:59Z"))).toBe("2026-11-09T00:00:00.000Z");
  });
});

describe("barPercent", () => {
  it("tỉ lệ theo giá trị lớn nhất, 0 khi không có dữ liệu", () => {
    expect(barPercent(50, 200)).toBe(25);
    expect(barPercent(200, 200)).toBe(100);
    expect(barPercent(5, 0)).toBe(0);
  });
});
