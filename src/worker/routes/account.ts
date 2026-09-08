import type { Hono } from "hono";
import type { AppBindings } from "../env";
import { body } from "../http";
import { hashPassword, verifyPassword } from "../security/password";
import { writeAuditDeferred } from "../services/audit";
import { clearSessionCookies as clearCookies } from "../services/auth";
import { consumeRateLimit } from "../services/rate-limit";
import { AppError } from "../shared/errors";
import { passwordSchema } from "../validation";

/** Authenticated account/session management for the current admin. */
export function registerAccountRoutes(app: Hono<AppBindings>): void {
  app.get("/api/auth/session", (context) => {
    const principal = context.get("principal");
    return context.json({ data: { username: principal.username, csrfToken: principal.csrfToken } });
  });

  app.post("/api/auth/logout", async (context) => {
    const principal = context.get("principal");
    await context.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(principal.sessionId).run();
    clearCookies(context);
    writeAuditDeferred(context, { adminId: principal.adminId, action: "auth.logout", targetType: "session", requestId: context.get("requestId") });
    return context.json({ data: { ok: true } });
  });

  app.put("/api/auth/password", async (context) => {
    const input = await body(context, passwordSchema);
    const principal = context.get("principal");
    // Changing a password rehashes and invalidates every other session; cap
    // it so a leaked session cannot be used to churn credentials.
    const limit = await consumeRateLimit(context.env, "password:" + principal.adminId, 10, 10 * 60_000);
    if (!limit.allowed) {
      context.header("retry-after", String(limit.retryAfter));
      throw new AppError(429, "操作过于频繁，请稍后重试", "password_rate_limited");
    }
    const admin = await context.env.DB.prepare("SELECT password_hash FROM admins WHERE id = ?").bind(principal.adminId).first<{ password_hash: string }>();
    if (!admin || !(await verifyPassword(input.currentPassword, admin.password_hash))) throw new AppError(403, "当前密码错误", "invalid_current_password");
    const now = new Date().toISOString();
    await context.env.DB.batch([
      context.env.DB.prepare("UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(input.newPassword), now, principal.adminId),
      context.env.DB.prepare("DELETE FROM sessions WHERE admin_id = ? AND id <> ?").bind(principal.adminId, principal.sessionId),
    ]);
    writeAuditDeferred(context, { adminId: principal.adminId, action: "auth.password.change", targetType: "admin", targetId: principal.adminId, requestId: context.get("requestId") });
    return context.json({ data: { ok: true } });
  });
}
