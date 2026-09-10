-- 0010_probe_safety
-- Auto-disable on a *single* TCP failure disabled 112 of 334 nodes, most of
-- them reachable in practice: a probe only proves "this edge could not
-- complete a TCP handshake right now", which is also what happens when the
-- upstream rate-limits or blocks Cloudflare egress, during a brief restart,
-- or for UDP-only transports.
--
-- `probe_fail_count` requires consecutive failures before a node leaves the
-- served set (and it still recovers on the first successful probe).

ALTER TABLE nodes ADD COLUMN probe_fail_count INTEGER NOT NULL DEFAULT 0;
