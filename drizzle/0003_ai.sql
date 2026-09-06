PRAGMA foreign_keys = ON;

CREATE TABLE ai_preferences (
  owner_id TEXT PRIMARY KEY REFERENCES profiles(id), provider TEXT, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  consent_version TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ai_invocations (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES profiles(id), provider TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('extract','report')), status TEXT NOT NULL CHECK(status IN ('reserved','running','succeeded','failed','unknown')),
  idempotency_key TEXT NOT NULL, lease_expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  error_class TEXT, input_hash TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, completed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner_id, idempotency_key)
);
CREATE INDEX ai_invocations_owner_status_idx ON ai_invocations(owner_id,status,created_at);

PRAGMA user_version = 4;
