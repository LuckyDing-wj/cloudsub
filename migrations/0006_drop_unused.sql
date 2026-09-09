-- 0006_drop_unused
-- Remove schema that nothing reads:
--
--   * `templates` — created as an "output template extension point" and
--     seeded at first-run initialisation, but no route ever reads it and
--     `subscriptions.template_id` is never written or queried.
--   * `subscriptions.template_id` — the dangling reference to it.
--   * `sessions.last_seen_at` — written on a throttled timer, never read by
--     any query or view.
--
-- Dropping the two columns keeps the schema honest: an unused NOT NULL
-- column still costs a write on every insert and invites the assumption
-- that the value is meaningful.

DROP TABLE IF EXISTS templates;

ALTER TABLE subscriptions DROP COLUMN template_id;

ALTER TABLE sessions DROP COLUMN last_seen_at;
