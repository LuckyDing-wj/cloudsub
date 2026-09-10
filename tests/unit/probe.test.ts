import { describe, expect, it } from "vitest";
import { nextEnabledState, PROBE_BATCH_SIZE, PROBE_FAIL_THRESHOLD, PROBE_TIMEOUT_MS } from "../../src/worker/services/probe";

describe("nextEnabledState (probe decision machine)", () => {
  it("leaves a serving node alone on success", () => {
    expect(nextEnabledState(true, false, true)).toEqual({ enabled: null, autoDisabled: 0 });
  });

  it("keeps a serving node alive on isolated failures (below the streak threshold)", () => {
    // A single failed handshake is not proof the node is dead — the upstream
    // may be rate-limiting Cloudflare egress or restarting.
    expect(nextEnabledState(true, false, false, 0)).toEqual({ enabled: null, autoDisabled: 0 });
    expect(nextEnabledState(true, false, false, 1)).toEqual({ enabled: null, autoDisabled: 0 });
  });

  it("auto-disables a serving node once the failure streak reaches the threshold", () => {
    expect(nextEnabledState(true, false, false, PROBE_FAIL_THRESHOLD - 1)).toEqual({ enabled: 0, autoDisabled: 1 });
  });

  it("resets the streak implicitly: success never disables", () => {
    expect(nextEnabledState(true, false, true, PROBE_FAIL_THRESHOLD)).toEqual({ enabled: null, autoDisabled: 0 });
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