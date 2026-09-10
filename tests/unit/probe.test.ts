import { describe, expect, it } from "vitest";
import { nextEnabledState, PROBE_BATCH_SIZE, PROBE_TIMEOUT_MS } from "../../src/worker/services/probe";

describe("nextEnabledState (probe decision machine)", () => {
  it("leaves a serving node alone on success", () => {
    expect(nextEnabledState(true, false, true)).toEqual({ enabled: null, autoDisabled: 0 });
  });

  it("auto-disables a serving node on a failed probe (threshold 1)", () => {
    expect(nextEnabledState(true, false, false)).toEqual({ enabled: 0, autoDisabled: 1 });
  });

  it("re-enables an auto-disabled node when it recovers", () => {
    expect(nextEnabledState(false, true, true)).toEqual({ enabled: 1, autoDisabled: 0 });
  });

  it("keeps an auto-disabled node off while it stays unreachable", () => {
    expect(nextEnabledState(false, true, false)).toEqual({ enabled: 0, autoDisabled: 1 });
  });

  it("never touches a manually disabled node", () => {
    expect(nextEnabledState(false, false, true)).toEqual({ enabled: null, autoDisabled: 0 });
    expect(nextEnabledState(false, false, false)).toEqual({ enabled: null, autoDisabled: 0 });
  });

  it("exports a bounded batch and timeout for the free-tier budget", () => {
    expect(PROBE_BATCH_SIZE).toBeLessThanOrEqual(30);
    expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
  });
});