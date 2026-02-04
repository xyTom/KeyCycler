-- KeyCycler v3.2 schema
-- Long-term key state only (UNKNOWN/ACTIVE/INVALID/QUOTA).

CREATE TABLE IF NOT EXISTS keys (
  key_id TEXT PRIMARY KEY,
  key_plain TEXT NOT NULL,
  status TEXT NOT NULL,
  last_checked INTEGER,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_status_keyid ON keys(status, key_id);

