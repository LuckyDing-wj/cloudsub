import { describe, expect, it } from "vitest";
import { sourceFailureText } from "../../src/worker/services/notify";

describe("sourceFailureText", () => {
  it("includes the source name, sanitized error and next retry time", () => {
    const text = sourceFailureText("Bandwidth 01", "fetch failed", "2026-09-09T12:00:00.000Z");
    expect(text).toContain("Bandwidth 01");
    expect(text).toContain("fetch failed");
    expect(text).toContain("2026-09-09T12:00:00.000Z");
  });

  it("renders a readable multi-line message", () => {
    const text = sourceFailureText("A", "boom", "later");
    expect(text.split("\n")).toEqual(["⚠️ 数据源刷新失败", "", "源：A", "错误：boom", "下次重试：later"]);
  });
});