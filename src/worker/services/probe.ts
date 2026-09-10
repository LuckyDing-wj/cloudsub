import { connect } from "cloudflare:sockets";
import type { Env } from "../env";

/**
 * Edge reachability probing, run by the scheduled handler after refresh.
 *
 * Reachability is measured from the Cloudflare edge (TCP handshake to the
 * node's server:port), so it answers "can this edge reach the node" — not
 * the latency or throughput the end user would experience. That is still
 * enough to catch dead/shut-down nodes and auto-disable them.
 *
 * Budget: each outstanding socket is one subrequest (free plan: 50/request)
 * and the runtime allows 6 simultaneous connections, so a run probes a
 * bounded batch with a small pool and round-robins by last probe time.
 */
export const PROBE_BATCH_SIZE = 30;
export const PROBE_TIMEOUT_MS = 4_000;

export interface ProbeDecision {
  /** 1 to enable, 0 to disable, null = leave untouched. */
  enabled: number | null;
  autoDisabled: number;
}

/**
 * Pure state machine for a node's enabled flag after one probe:
 *
 *   serving        + ok      -> stays serving
 *   serving        + fail    -> auto-disable
 *   auto-disabled  + ok      -> re-enable (recovery)
 *   auto-disabled  + fail    -> stays off
 *   manually off   + any     -> hands off (manual choice wins)
 */
export function nextEnabledState(prevEnabled: boolean, prevAutoDisabled: boolean, probeOk: boolean): ProbeDecision {
  if (prevAutoDisabled) {
    return probeOk ? { enabled: 1, autoDisabled: 0 } : { enabled: 0, autoDisabled: 1 };
  }
  if (!prevEnabled) return { enabled: null, autoDisabled: 0 };
  return probeOk ? { enabled: null, autoDisabled: 0 } : { enabled: 0, autoDisabled: 1 };
}

export async function probeTcp(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ ok: boolean; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const finish = (ok: boolean, timer?: ReturnType<typeof setTimeout>): void => {
      if (timer) clearTimeout(timer);
      resolve({ ok, ms: Date.now() - started });
    };
    let socket: ReturnType<typeof connect>;
    try {
      socket = connect({ hostname: host, port }, { secureTransport: "off", allowHalfOpen: false });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* already closed */ }
      finish(false);
    }, timeoutMs);
    socket.opened
      .then(() => {
        try { socket.close(); } catch { /* already closed */ }
        finish(true, timer);
      })
      .catch(() => finish(false, timer));
  });
}

/** Probe a bounded round-robin batch of in-service/auto-disabled nodes. */
export async function probeDueNodes(env: Env): Promise<void> {
  const due = await env.DB.prepare(
    "SELECT id, source_id, server, port, enabled, auto_disabled FROM nodes WHERE present = 1 AND (enabled = 1 OR auto_disabled = 1) ORDER BY last_probe_at ASC NULLS FIRST LIMIT ?",
  ).bind(PROBE_BATCH_SIZE).all<{ id: string; source_id: string; server: string; port: number; enabled: number; auto_disabled: number }>();
  const now = new Date().toISOString();
  const changedSourceIds = new Set<string>();
  let cursor = 0;
  const runners = Array.from({ length: Math.min(5, due.results.length) }, async () => {
    while (cursor < due.results.length) {
      const node = due.results[cursor];
      cursor += 1;
      const probe = await probeTcp(node.server, node.port);
      const decision = nextEnabledState(Boolean(node.enabled), Boolean(node.auto_disabled), probe.ok);
      await env.DB.prepare(
        "UPDATE nodes SET last_probe_at = ?, last_probe_ms = ?, probe_ok = ?, auto_disabled = ?, enabled = COALESCE(?, enabled), updated_at = ? WHERE id = ?",
      ).bind(now, probe.ok ? probe.ms : 0, probe.ok ? 1 : 0, decision.autoDisabled, decision.enabled, now, node.id).run();
      if (decision.enabled !== null) changedSourceIds.add(node.source_id);
    }
  });
  await Promise.all(runners);
  // A node entering/leaving the served set must invalidate its subscriptions'
  // cached output; a source change leaves the probe columns untouched.
  if (changedSourceIds.size > 0) {
    const ids = [...changedSourceIds];
    const placeholders = ids.map(() => "?").join(",");
    await env.DB.prepare(
      "UPDATE subscriptions SET revision = revision + 1, updated_at = ? WHERE id IN (SELECT subscription_id FROM subscription_sources WHERE source_id IN (" + placeholders + "))",
    ).bind(now, ...ids).run();
  }
}