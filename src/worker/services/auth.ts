import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppBindings, Env } from "../env";
import { constantTimeEqual, hmacSha256Hex, randomToken } from "../security/crypto";
import { AppError } from "../shared/errors";

export const SESSION_COOKIE = "cloudsub_session";
export const CSRF_COOKIE = "cloudsub_csrf";

interface SessionRow {
  session_id: string;
  admin_id: string;
  username: string;
  csrf_token: string;
}

export async function createSession(env: Env, adminId: string): Promise<{ token: string; csrfToken: string; expiresAt: string }> {
  if (!env.APP_SECRET) throw new AppError(503, "尚未配置应用密钥", "missing_app_secret");
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const now = new Date();
  const ttl = Math.max(900, Math.min(Number(env.SESSION_TTL) || 604_800, 2_592_000));
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (id, admin_id, token_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), adminId, await hmacSha256Hex(env.APP_SECRET, token), csrfToken, expiresAt, now.toISOString()).run();
  return { token, csrfToken, expiresAt };
}

export function setSessionCookies(context: Context<AppBindings>, session: { token: string; csrfToken: string; expiresAt: string }): void {
  const secure = new URL(context.req.url).protocol === "https:";
  const common = { path: "/", sameSite: "Strict" as const, secure, expires: new Date(session.expiresAt) };
  setCookie(context, SESSION_COOKIE, session.token, { ...common, httpOnly: true });
  setCookie(context, CSRF_COOKIE, session.csrfToken, { ...common, httpOnly: false });
}

/**
 * Per-(IP, username) login throttling, persisted in D1.
 *
 * Brute-force protection for the single-admin login path: five failed
 * attempts within a 15-minute window lock the key. The lock check runs
 * BEFORE PBKDF2 verification, so a locked key costs no CPU — keeping the
 * login path inside the Workers free-tier 10 ms/request budget.
 */
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export function loginThrottleKey(clientIp: string | undefined, username: string): string {
  // usernames are restricted to [A-Za-z0-9_.-], so `|` cannot collide.
  return (clientIp ?? "unknown") + "|" + username;
}

export async function isLoginLocked(env: Env, key: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT locked_until FROM login_attempts WHERE key = ?")
    .bind(key).first<{ locked_until: string | null }>();
  return Boolean(row?.locked_until && row.locked_until > new Date().toISOString());
}

export async function recordLoginFailure(env: Env, key: string): Promise<void> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - LOCKOUT_MS).toISOString();
  const lockedUntil = new Date(now.getTime() + LOCKOUT_MS).toISOString();
  // Atomic upsert: a read-modify-write here loses updates under concurrent
  // failures (parallel brute-force requests all read the same count), so the
  // increment happens inside the statement. In a SQLite upsert the
  // unqualified `updated_at`/`attempts` refer to the pre-update row.
  await env.DB.prepare(
    "INSERT INTO login_attempts (key, attempts, locked_until, updated_at) VALUES (?, 1, NULL, ?) " +
    "ON CONFLICT(key) DO UPDATE SET " +
    "attempts = CASE WHEN updated_at >= ? THEN attempts + 1 ELSE 1 END, " +
    "locked_until = CASE WHEN (CASE WHEN updated_at >= ? THEN attempts + 1 ELSE 1 END) >= ? THEN ? ELSE NULL END, " +
    "updated_at = excluded.updated_at",
  ).bind(key, now.toISOString(), windowStart, windowStart, MAX_LOGIN_ATTEMPTS, lockedUntil).run();
}

export async function clearLoginFailures(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}

export function clearSessionCookies(context: Context<AppBindings>): void {
  const secure = new URL(context.req.url).protocol === "https:";
  deleteCookie(context, SESSION_COOKIE, { path: "/", secure });
  deleteCookie(context, CSRF_COOKIE, { path: "/", secure });
}

export const requireAuth = createMiddleware<AppBindings>(async (context, next) => {
  const token = getCookie(context, SESSION_COOKIE);
  if (!token) throw new AppError(401, "请先登录", "authentication_required");
  if (!context.env.APP_SECRET) throw new AppError(503, "尚未配置应用密钥", "missing_app_secret");
  const now = new Date().toISOString();
  const session = await context.env.DB.prepare(
    "SELECT s.id AS session_id, s.csrf_token, s.expires_at, a.id AS admin_id, a.username FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1",
  ).bind(await hmacSha256Hex(context.env.APP_SECRET, token), now).first<SessionRow>();
  if (!session) {
    clearSessionCookies(context);
    throw new AppError(401, "会话已失效", "invalid_session");
  }
  context.set("principal", {
    adminId: session.admin_id,
    username: session.username,
    sessionId: session.session_id,
    csrfToken: session.csrf_token,
  });
  await next();
});

export const requireCsrf = createMiddleware<AppBindings>(async (context, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(context.req.method)) return next();
  const requestOrigin = context.req.header("origin");
  const expectedOrigin = context.env.APP_ORIGIN?.trim() || new URL(context.req.url).origin;
  if (requestOrigin && requestOrigin !== expectedOrigin) throw new AppError(403, "跨站请求已拒绝", "origin_mismatch");
  const header = context.req.header("x-csrf-token") ?? "";
  const cookie = getCookie(context, CSRF_COOKIE) ?? "";
  const expected = context.get("principal").csrfToken;
  if (!header || !cookie || !constantTimeEqual(header, cookie) || !constantTimeEqual(header, expected)) {
    throw new AppError(403, "CSRF 校验失败", "csrf_failed");
  }
  await next();
});
