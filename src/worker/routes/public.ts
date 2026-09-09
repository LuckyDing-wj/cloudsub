import type { Hono } from "hono";
import type { AppBindings } from "../env";
import { body } from "../http";
import { constantTimeEqual } from "../security/crypto";
import { hashPassword, verifyPassword } from "../security/password";
import { createSession as startSession, clearLoginFailures, isLoginLocked, loginThrottleKey, recordLoginFailure, setSessionCookies } from "../services/auth";
import { generateSubscription } from "../services/subscriptions";
import { AppError } from "../shared/errors";
import { loginSchema, setupSchema } from "../validation";

/**
 * Routes that must remain reachable without an authenticated session:
 * health probe, first-run system status/initialisation, login, and the
 * public subscription endpoint. Registered before the auth middleware so
 * they are never gated behind it.
 */
export function registerPublicRoutes(app: Hono<AppBindings>): void {
  app.get("/health", async (context) => {
    try {
      await context.env.DB.prepare("SELECT 1").first();
      return context.json({ status: "ok", service: context.env.APP_NAME || "CloudSub", time: new Date().toISOString() });
    } catch {
      return context.json({ status: "degraded", service: context.env.APP_NAME || "CloudSub" }, 503);
    }
  });

  app.get("/api/system/status", async (context) => {
    try {
      const admin = await context.env.DB.prepare("SELECT id FROM admins LIMIT 1").first<{ id: string }>();
      return context.json({ data: { initialized: Boolean(admin), migrationsReady: true, secretsConfigured: Boolean(context.env.APP_SECRET && context.env.DATA_ENCRYPTION_KEY), setupTokenRequired: Boolean(context.env.INITIAL_ADMIN_TOKEN) } });
    } catch {
      return context.json({ data: { initialized: false, migrationsReady: false, secretsConfigured: Boolean(context.env.APP_SECRET && context.env.DATA_ENCRYPTION_KEY), setupTokenRequired: Boolean(context.env.INITIAL_ADMIN_TOKEN) } });
    }
  });

  app.post("/api/system/initialize", async (context) => {
    const input = await body(context, setupSchema);
    if (!context.env.APP_SECRET || !context.env.DATA_ENCRYPTION_KEY) throw new AppError(503, "请先配置 APP_SECRET 和 DATA_ENCRYPTION_KEY", "missing_secrets");
    if (context.env.INITIAL_ADMIN_TOKEN && !constantTimeEqual(input.setupToken ?? "", context.env.INITIAL_ADMIN_TOKEN)) {
      throw new AppError(403, "初始化令牌无效", "invalid_setup_token");
    }
    const existing = await context.env.DB.prepare("SELECT id FROM admins LIMIT 1").first<{ id: string }>();
    if (existing) throw new AppError(409, "系统已经完成初始化", "already_initialized");
    const adminId = crypto.randomUUID();
    const now = new Date().toISOString();
    await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO admins (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(adminId, input.username, await hashPassword(input.password), now, now),
      context.env.DB.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('system', ?, ?)").bind(JSON.stringify({ timezone: "UTC", initializedAt: now }), now),
    ]);
    const session = await startSession(context.env, adminId);
    setSessionCookies(context, session);
    return context.json({ data: { username: input.username, csrfToken: session.csrfToken } }, 201);
  });

  app.post("/api/auth/login", async (context) => {
    const input = await body(context, loginSchema);
    const throttleKey = loginThrottleKey(context.req.header("cf-connecting-ip"), input.username);
    if (await isLoginLocked(context.env, throttleKey)) {
      throw new AppError(429, "尝试次数过多，请稍后再试", "login_throttled");
    }
    const admin = await context.env.DB.prepare("SELECT id, username, password_hash FROM admins WHERE username = ? LIMIT 1").bind(input.username).first<{ id: string; username: string; password_hash: string }>();
    if (!admin || !(await verifyPassword(input.password, admin.password_hash))) {
      await recordLoginFailure(context.env, throttleKey);
      throw new AppError(401, "用户名或密码错误", "invalid_credentials");
    }
    await clearLoginFailures(context.env, throttleKey);
    const session = await startSession(context.env, admin.id);
    setSessionCookies(context, session);
    return context.json({ data: { username: admin.username, csrfToken: session.csrfToken } });
  });

  app.get("/sub/:token", async (context) => {
    const token = context.req.param("token");
    const result = await generateSubscription(context.env, token, context.req.query("target"));
    context.executionCtx.waitUntil(context.env.DB.prepare("UPDATE subscription_tokens SET last_access_at = ? WHERE id = ?").bind(new Date().toISOString(), result.tokenId).run());
    const headers = {
      "content-type": result.contentType,
      "etag": result.etag,
      "cache-control": "private, max-age=" + result.cacheTtl,
      "content-disposition": "attachment; filename=\"" + result.name.replace(/[^A-Za-z0-9_.-]/gu, "-") + "." + result.extension + "\"",
      "profile-update-interval": "6",
    };
    if (context.req.header("if-none-match") === result.etag) return context.body(null, 304, headers);
    return context.body(result.body, 200, headers);
  });
}
