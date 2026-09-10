-- 0008_revealable_tokens
-- Store the subscription token so the dashboard can show/copy the full
-- subscription URL at any time.
--
-- Only `token_hash` (HMAC) was kept before, which is one-way: the full token
-- existed exactly once, in the create/rotate response. The plaintext is
-- stored AES-GCM encrypted with DATA_ENCRYPTION_KEY — the same key that
-- already protects upstream URLs and payloads — so a database leak alone
-- still does not expose it.

ALTER TABLE subscription_tokens ADD COLUMN token_encrypted TEXT;
