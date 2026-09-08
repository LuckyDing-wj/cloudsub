-- 0005_performance_ratelimit
-- Additive performance and abuse-control changes:
--
--   1. Indexes for the dashboard's hottest reads that had none:
--      * nodes ordered by name (COLLATE NOCASE) — every node page request sorts.
--      * sources ordered by name (COLLATE NOCASE) — the source picker.
--      * source_fetch_logs(status, created_at) — the dashboard error feed.
--      * audit_logs(admin_id) — the audit log join.
--
--   2. `sources.failure_count` — consecutive refresh failures, used to back
--      off a broken source (exponential delay capped at 6h) so it cannot
--      starve the rest of the due-source queue.
--
--   3. `rate_limits` — a durable, atomic-ish counter table. KV counters are
--      eventually consistent, so the previous read-modify-write limiter
--      could be bypassed by concurrent requests. D1 serialises writes, so
--      the counter is incremented with a guarded UPDATE instead.
--
-- Purely additive and safe to apply to an existing database.

CREATE INDEX IF NOT EXISTS idx_nodes_name_nocase ON nodes (name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_sources_name_nocase ON sources (name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_source_logs_status_created ON source_fetch_logs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id ON audit_logs (admin_id);

ALTER TABLE sources ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER,
  updated_at TEXT NOT NULL
);
