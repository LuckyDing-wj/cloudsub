-- 0008_login_throttle
-- Login brute-force protection: a per-(IP, username) attempt counter in D1.
-- Five failed attempts within a 15-minute window lock the key; a successful
-- login clears it. Purely D1-backed, so a single-admin deployment needs no
-- shared state. Old rows are pruned by the refresh cron (sources.ts).

CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_login_attempts_updated_at ON login_attempts (updated_at);