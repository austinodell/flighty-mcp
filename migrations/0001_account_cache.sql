-- Trimmed Flighty account snapshot. Reads use the published generation.
-- A refresh writes the next generation and flips the pointer only after the last page.

CREATE TABLE account_cache (
  account_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'empty',
  generation INTEGER NOT NULL DEFAULT 0,
  staging_generation INTEGER,
  fetched_at TEXT,
  stored_at INTEGER,
  pages INTEGER NOT NULL DEFAULT 0,
  pages_done INTEGER NOT NULL DEFAULT 0,
  unknown_fields INTEGER NOT NULL DEFAULT 0,
  cursor TEXT,
  seen_cursors TEXT NOT NULL DEFAULT '[]',
  counts_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  lock_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE account_records (
  account_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL,
  record_key TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  record_id TEXT NOT NULL DEFAULT '',
  flight_id TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0,
  updated TEXT,
  payload TEXT NOT NULL,
  PRIMARY KEY (account_id, generation, kind, record_key)
);

CREATE INDEX idx_account_records_kind
  ON account_records (account_id, generation, kind, deleted, user_id);

CREATE INDEX idx_account_records_flight
  ON account_records (account_id, generation, kind, flight_id);
