import { describe, expect, it } from "vitest";
import { classifyDiffLine, parseFindings, sessionDuration, summarizeToolInput } from "./format";

describe("sessionDuration", () => {
  const start = "2026-11-20T01:00:00.000Z";
  it("chia giây, phút, giờ", () => {
    expect(sessionDuration({ startedAt: start, endedAt: "2026-11-20T01:00:42.000Z" })).toEqual({
      key: "seconds",
      values: { s: 42 },
    });
    expect(sessionDuration({ startedAt: start, endedAt: "2026-11-20T01:05:00.000Z" })).toEqual({
      key: "minutes",
      values: { m: 5 },
    });
    expect(sessionDuration({ startedAt: start, endedAt: "2026-11-20T02:30:00.000Z" })).toEqual({
      key: "hours",
      values: { h: 1, m: 30 },
    });
  });
  it("null khi còn chạy hoặc thời gian ngược", () => {
    expect(sessionDuration({ startedAt: start, endedAt: null })).toBeNull();
    expect(sessionDuration({ startedAt: start, endedAt: "2026-11-20T00:00:00.000Z" })).toBeNull();
  });
});

describe("classifyDiffLine", () => {
  it("phân loại dòng diff", () => {
    expect(classifyDiffLine("@@ -1 +1 @@")).toBe("hunk");
    expect(classifyDiffLine("+a")).toBe("add");
    expect(classifyDiffLine("-a")).toBe("remove");
    expect(classifyDiffLine("+++ b/a.ts")).toBe("context");
    expect(classifyDiffLine(" a")).toBe("context");
  });
});

describe("summarizeToolInput", () => {
  it("ưu tiên command/file_path và cắt dài", () => {
    expect(summarizeToolInput({ command: "pnpm  test\n--run" })).toBe("pnpm test --run");
    expect(summarizeToolInput({ file_path: "src/a.ts", content: "x" })).toBe("src/a.ts");
    expect(summarizeToolInput({ n: 1 })).toBe('{"n":1}');
    expect(summarizeToolInput({ command: ["pytest", "-q"], timeout_ms: 1 })).toBe("pytest -q");
    expect(summarizeToolInput(null)).toBe("");
    expect(summarizeToolInput({ command: "x".repeat(200) }, 10)).toHaveLength(10);
  });
});

describe("parseFindings", () => {
  it("nhận mảng hoặc { items } và bỏ phần tử sai", () => {
    expect(parseFindings([{ ruleId: "r", severity: "low", message: "m", turnSeq: 1 }, 1, { ruleId: "x" }])).toEqual([
      { id: "r-0", ruleId: "r", severity: "low", message: "m", turnSeq: 1 },
    ]);
    expect(parseFindings({ items: [{ ruleKey: "k", message: "m" }] })).toEqual([
      { id: "k-0", ruleId: "k", severity: "info", message: "m", turnSeq: null },
    ]);
  });
  it("dạng lạ trả null", () => {
    expect(parseFindings("x")).toBeNull();
    expect(parseFindings({ data: [] })).toBeNull();
  });
});
