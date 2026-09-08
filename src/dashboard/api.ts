export class ApiError extends Error {
  constructor(message: string, public readonly code = "request_failed", public readonly details?: unknown) {
    super(message);
  }
}

/** Fired once when the API returns 401 (expired/invalid session). */
export const SESSION_EXPIRED_EVENT = "cloudsub:session-expired";

function csrfCookie(): string | undefined {
  const entry = document.cookie.split("; ").find((value) => value.startsWith("cloudsub_csrf="));
  return entry ? decodeURIComponent(entry.slice(entry.indexOf("=") + 1)) : undefined;
}

export function onSessionExpired(handler: () => void): () => void {
  const listener = () => handler();
  window.addEventListener(SESSION_EXPIRED_EVENT, listener);
  return () => window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
}

// Short-lived cache for GET responses. Every page component mounts fresh on
// navigation, so without this switching tabs and coming back refetches
// everything it just fetched. Mutations invalidate the whole cache — the
// data is small and always refetched after a write anyway.
const GET_CACHE_TTL_MS = 10_000;
const getCache = new Map<string, { at: number; payload: unknown }>();

export function invalidateApiCache(): void {
  getCache.clear();
}

function invalidateIfStale(): void {
  const cutoff = Date.now() - GET_CACHE_TTL_MS * 10;
  for (const [key, entry] of getCache) if (entry.at < cutoff) getCache.delete(key);
}

const REQUEST_TIMEOUT_MS = 30_000;

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const isRead = ["GET", "HEAD", "OPTIONS"].includes(method);
  if (isRead) {
    invalidateIfStale();
    const cached = getCache.get(path);
    if (cached && Date.now() - cached.at < GET_CACHE_TTL_MS) return cached.payload as T;
  }
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (!isRead) {
    const csrf = csrfCookie();
    if (csrf) headers.set("x-csrf-token", csrf);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new ApiError("请求超时", "request_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => ({})) as { data?: T; error?: { message?: string; code?: string; details?: unknown } };
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new ApiError(payload.error?.message ?? "请求失败", payload.error?.code, payload.error?.details);
  }
  if (isRead) getCache.set(path, { at: Date.now(), payload: payload.data });
  else invalidateApiCache();
  return payload.data as T;
}
