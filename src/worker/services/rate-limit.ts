import type { Env } from "../env";

/**
 * Durable rate limiting.
 *
 * KV is eventually consistent, so the previous `get -> +1 -> put` counters
 * could be bypassed by concurrent requests (each edge reading a stale
 * count). D1 serialises writes against the primary, so counters live there;
 * the increment is a guarded UPDATE that only applies while the window is
 * still current, which keeps the count monotonic within a window.
 *
 * The limiter is best-effort by design: a D1 failure must never take a
 * request down, so failures fail open (and are swallowed).
 */

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}

export async function consumeRateLimit(
  env: Env,
  key: string,
  limit: number,
  windowMs: number,
  blockMs = 0,
): Promise<RateLimitResult> {
  const now = Date.now();
  try {
    const existing = await env.DB.prepare(
      "SELECT window_start, count, blocked_until FROM rate_limits WHERE bucket_key = ?",
    ).bind(key).first<{ window_start: number; count: number; blocked_until: number | null }>();

    if (existing?.blocked_until && existing.blocked_until > now) {
      return { allowed: false, retryAfter: Math.ceil((existing.blocked_until - now) / 1000) };
    }

    const windowActive = existing !== null && now - existing.window_start < windowMs;
    if (windowActive) {
      // Guarded increment: only counts while the window has not rolled over.
      await env.DB.prepare("UPDATE rate_limits SET count = count + 1, updated_at = ? WHERE bucket_key = ? AND window_start = ?")
        .bind(new Date(now).toISOString(), key, existing.window_start).run();
      const count = existing.count + 1;
      if (count > limit) {
        if (blockMs > 0) {
          const blockedUntil = now + blockMs;
          await env.DB.prepare("UPDATE rate_limits SET blocked_until = ?, updated_at = ? WHERE bucket_key = ?")
            .bind(blockedUntil, new Date(now).toISOString(), key).run();
          return { allowed: false, retryAfter: Math.ceil(blockMs / 1000) };
        }
        return { allowed: false, retryAfter: Math.ceil((existing.window_start + windowMs - now) / 1000) };
      }
      return { allowed: true, retryAfter: 0 };
    }

    await env.DB.prepare(
      "INSERT INTO rate_limits (bucket_key, window_start, count, blocked_until, updated_at) VALUES (?, ?, 1, NULL, ?) " +
      "ON CONFLICT(bucket_key) DO UPDATE SET window_start = excluded.window_start, count = 1, blocked_until = NULL, updated_at = excluded.updated_at",
    ).bind(key, now, new Date(now).toISOString()).run();
    return { allowed: limit > 0, retryAfter: 0 };
  } catch {
    // Never let the limiter break the request it is protecting.
    return { allowed: true, retryAfter: 0 };
  }
}

/** Clear a bucket (e.g. after a successful login). */
export async function clearRateLimit(env: Env, key: string): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM rate_limits WHERE bucket_key = ?").bind(key).run();
  } catch { /* best-effort */ }
}
