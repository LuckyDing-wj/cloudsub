import type { NormalizedNode, SubscriptionRules, SubscriptionTarget } from "../../shared/types";
import { applySubscriptionRules, renderSubscription } from "../adapters/output";
import type { Env } from "../env";
import { decryptJson, encryptJson, hmacSha256Hex, randomToken, sha256Hex } from "../security/crypto";
import { AppError } from "../shared/errors";

interface AccessRow {
  token_id: string;
  subscription_id: string;
  name: string;
  slug: string;
  default_target: SubscriptionTarget;
  rules_json: string;
  revision: number;
  cache_ttl: number;
  subscription_expires_at: string | null;
  token_expires_at: string | null;
}

interface NodeRow {
  id: string;
  source_id: string;
  fingerprint: string;
  name: string;
  protocol: string;
  server: string;
  port: number;
  config_json: string;
  raw_uri: string | null;
  enabled: number;
}

/**
 * Hard cap on nodes served per subscription. Bounds per-request CPU
 * (rule filtering + rendering) on the Workers free tier (10 ms/request);
 * a slightly larger row set is fetched so the guard can distinguish
 * "hit the cap" from "exactly at the cap".
 */
export const MAX_SERVE_NODES = 2_000;

export async function issueSubscriptionToken(env: Env, subscriptionId: string, expiresAt?: string): Promise<{ token: string; prefix: string }> {
  if (!env.APP_SECRET) throw new AppError(503, "尚未配置应用密钥", "missing_app_secret");
  const token = randomToken(32);
  const prefix = token.slice(0, 8);
  // Only the HMAC is needed to authenticate a request, but the plaintext is
  // kept (encrypted) so the dashboard can reveal the full subscription URL
  // later — otherwise the token exists only in the create/rotate response.
  const encrypted = env.DATA_ENCRYPTION_KEY ? await encryptJson(token, env.DATA_ENCRYPTION_KEY) : null;
  await env.DB.prepare(
    "INSERT INTO subscription_tokens (id, subscription_id, token_hash, token_prefix, token_encrypted, enabled, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
  ).bind(crypto.randomUUID(), subscriptionId, await hmacSha256Hex(env.APP_SECRET, token), prefix, encrypted, expiresAt ?? null, new Date().toISOString()).run();
  return { token, prefix };
}

/**
 * Reveal the current token of a subscription.
 *
 * Tokens issued before the encrypted column existed cannot be recovered —
 * that case is reported so the UI can ask for a rotation instead of failing
 * silently.
 */
export async function revealSubscriptionToken(env: Env, subscriptionId: string): Promise<string> {
  if (!env.DATA_ENCRYPTION_KEY) throw new AppError(503, "尚未配置数据加密密钥", "missing_encryption_key");
  const row = await env.DB.prepare(
    "SELECT token_encrypted FROM subscription_tokens WHERE subscription_id = ? AND enabled = 1 ORDER BY created_at DESC LIMIT 1",
  ).bind(subscriptionId).first<{ token_encrypted: string | null }>();
  if (!row) throw new AppError(404, "订阅不存在或没有可用令牌", "token_not_found");
  if (!row.token_encrypted) throw new AppError(422, "该令牌创建于升级之前，无法恢复，请轮换令牌", "token_not_recoverable");
  return decryptJson<string>(row.token_encrypted, env.DATA_ENCRYPTION_KEY);
}

function parseRules(value: string): SubscriptionRules {
  try { return JSON.parse(value) as SubscriptionRules; } catch { return {}; }
}

function rowToNode(row: NodeRow): NormalizedNode {
  return {
    id: row.id,
    sourceId: row.source_id,
    fingerprint: row.fingerprint,
    name: row.name,
    protocol: row.protocol,
    server: row.server,
    port: row.port,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    rawUri: row.raw_uri ?? undefined,
    enabled: Boolean(row.enabled),
  };
}

export async function generateSubscription(env: Env, token: string, requestedTarget?: string): Promise<{
  body: string;
  contentType: string;
  extension: string;
  etag: string;
  name: string;
  cacheTtl: number;
  tokenId: string;
}> {
  if (token.length < 32 || token.length > 200) throw new AppError(404, "订阅不可用", "subscription_unavailable");
  const now = new Date().toISOString();
  if (!env.APP_SECRET) throw new AppError(503, "尚未配置应用密钥", "missing_app_secret");
  const access = await env.DB.prepare(
    "SELECT t.id AS token_id, s.id AS subscription_id, s.name, s.slug, s.default_target, s.rules_json, s.revision, s.cache_ttl, s.expires_at AS subscription_expires_at, t.expires_at AS token_expires_at FROM subscription_tokens t JOIN subscriptions s ON s.id = t.subscription_id WHERE t.token_hash = ? AND t.enabled = 1 AND s.enabled = 1 LIMIT 1",
  ).bind(await hmacSha256Hex(env.APP_SECRET, token)).first<AccessRow>();
  if (!access || (access.subscription_expires_at && access.subscription_expires_at <= now) || (access.token_expires_at && access.token_expires_at <= now)) {
    throw new AppError(404, "订阅不可用", "subscription_unavailable");
  }
  const target = (requestedTarget || access.default_target) as SubscriptionTarget;
  if (!["raw", "mihomo", "singbox", "json"].includes(target)) throw new AppError(404, "订阅不可用", "subscription_unavailable");
  const cacheKey = "subscription:" + access.subscription_id + ":" + target + ":" + access.revision;
  // Points at the cache key of the current revision so the previous one can
  // be dropped explicitly instead of lingering in KV until its TTL expires.
  const pointerKey = "subscription:ptr:" + access.subscription_id + ":" + target;
  const cached = await env.CACHE.get<{ body: string; contentType: string; extension: string; etag: string }>(cacheKey, "json");
  const cacheTtl = Math.max(60, Math.min(access.cache_ttl || Number(env.SUB_CACHE_TTL) || 300, 86_400));
  if (cached) return { ...cached, name: access.slug || access.name, cacheTtl, tokenId: access.token_id };
  const result = await env.DB.prepare(
    "SELECT n.* FROM nodes n JOIN subscription_sources ss ON ss.source_id = n.source_id JOIN sources s ON s.id = n.source_id WHERE ss.subscription_id = ? AND s.enabled = 1 AND n.enabled = 1 AND n.present = 1 LIMIT ?",
  ).bind(access.subscription_id, MAX_SERVE_NODES + 1).all<NodeRow>();
  // Reject instead of silently truncating: a cut-down subscription serves an
  // incomplete client config, which is worse than an explicit failure.
  if (result.results.length > MAX_SERVE_NODES) {
    throw new AppError(422, "订阅节点超过上限（" + MAX_SERVE_NODES + "），请先移除部分节点", "subscription_too_many_nodes");
  }
  const rules = parseRules(access.rules_json);
  const nodes = applySubscriptionRules(result.results.map(rowToNode), rules);
  const rendered = renderSubscription(nodes, target, rules.output);
  const etag = '"' + await sha256Hex(rendered.body) + '"';
  // A KV value is capped at 25 MiB. An oversized subscription must skip the
  // cache rather than fail the request with a 500 on the `put`.
  const entry = JSON.stringify({ ...rendered, etag });
  if (new TextEncoder().encode(entry).byteLength <= 20 * 1024 * 1024) {
    await env.CACHE.put(cacheKey, entry, { expirationTtl: cacheTtl });
    // Only runs on a cache miss (a revision change), so the extra KV ops are
    // not on the hot path.
    const previous = await env.CACHE.get(pointerKey);
    if (previous && previous !== cacheKey) await env.CACHE.delete(previous);
    await env.CACHE.put(pointerKey, cacheKey, { expirationTtl: Math.max(cacheTtl, 86_400) });
  }
  await env.DB.prepare("UPDATE subscriptions SET last_generated_at = ? WHERE id = ?").bind(now, access.subscription_id).run();
  return { ...rendered, etag, name: access.slug || access.name, cacheTtl, tokenId: access.token_id };
}
