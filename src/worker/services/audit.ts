import type { Context } from "hono";
import type { AppBindings, Env } from "../env";

export interface AuditEntry {
  adminId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export async function writeAudit(env: Env, entry: AuditEntry): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, admin_id, action, target_type, target_id, details_json, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    crypto.randomUUID(),
    entry.adminId ?? null,
    entry.action,
    entry.targetType ?? null,
    entry.targetId ?? null,
    JSON.stringify(entry.details ?? {}),
    entry.requestId ?? null,
    new Date().toISOString(),
  ).run();
}

/**
 * Fire-and-forget audit write.
 *
 * Audit logging must never add latency to (or fail) the mutation it records,
 * so route handlers defer it to `waitUntil`: the response is returned as soon
 * as the real work is done and the insert is flushed afterwards.
 */
export function writeAuditDeferred(context: Context<AppBindings>, entry: Omit<AuditEntry, "requestId"> & { requestId?: string }): void {
  context.executionCtx.waitUntil(
    writeAudit(context.env, { ...entry, requestId: entry.requestId ?? context.get("requestId") }).catch(() => undefined),
  );
}
