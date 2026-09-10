-- 0009_node_probe
-- Edge reachability probing for nodes: per-node last probe outcome plus an
-- auto-disabled flag. A node reachable from the Cloudflare edge is assumed
-- usable; one that fails a probe is auto-disabled immediately (threshold: 1
-- failure) and re-enabled once a later probe succeeds. Manual enabled-state
-- writes clear auto_disabled so human choices always win until the next
-- probe contradicts them.

ALTER TABLE nodes ADD COLUMN last_probe_at TEXT;
ALTER TABLE nodes ADD COLUMN last_probe_ms INTEGER;
ALTER TABLE nodes ADD COLUMN probe_ok INTEGER;
ALTER TABLE nodes ADD COLUMN auto_disabled INTEGER NOT NULL DEFAULT 0;

-- Round-robin probe picker: oldest-probed (or never-probed) nodes first.
CREATE INDEX idx_nodes_probe_due ON nodes (present, last_probe_at);