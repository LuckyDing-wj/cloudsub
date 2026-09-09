-- 0007_simplify_personal
-- Personal-use trim: drop features with no reader left after removal.
--
--   * audit_logs        — the audit trail and its dashboard page are gone.
--   * rate_limits       — durable rate limiting removed (single-admin use).
--   * nodes.tags_json   — the tag system had no editing UI and no consumer.
--   * nodes_staging.tags_json — mirrors the nodes column.

DROP TABLE IF EXISTS audit_logs;

DROP TABLE IF EXISTS rate_limits;

ALTER TABLE nodes DROP COLUMN tags_json;

ALTER TABLE nodes_staging DROP COLUMN tags_json;
