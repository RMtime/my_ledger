PRAGMA foreign_keys = ON;

CREATE TABLE profiles (
  id TEXT PRIMARY KEY, auth_subject TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Hong_Kong', base_currency TEXT NOT NULL DEFAULT 'HKD',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES profiles(id), name TEXT NOT NULL, type TEXT NOT NULL,
  currency TEXT NOT NULL, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner_id, name), UNIQUE(owner_id, id)
);
CREATE TABLE categories (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES profiles(id), name TEXT NOT NULL, parent_id TEXT,
  transaction_kind TEXT NOT NULL CHECK(transaction_kind IN ('expense','income','refund')),
  archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner_id, name, transaction_kind), UNIQUE(owner_id, id),
  FOREIGN KEY(owner_id, parent_id) REFERENCES categories(owner_id, id)
);
CREATE TABLE channels (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES profiles(id), name TEXT NOT NULL,
  archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner_id, name), UNIQUE(owner_id, id)
);
CREATE TABLE transactions (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES profiles(id),
  kind TEXT NOT NULL CHECK(kind IN ('expense','income','refund','transfer')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0 AND amount_minor <= 999999999999999),
  currency TEXT NOT NULL CHECK(length(currency)=3), occurred_at TEXT NOT NULL, occurred_timezone TEXT NOT NULL,
  time_precision TEXT NOT NULL CHECK(time_precision IN ('date','minute','second')),
  category_id TEXT, payment_method TEXT, account_id TEXT, channel_id TEXT, merchant TEXT, note TEXT,
  related_transaction_id TEXT, transfer_group_id TEXT, transfer_direction TEXT CHECK(transfer_direction IN ('in','out') OR transfer_direction IS NULL),
  source TEXT NOT NULL CHECK(source IN ('manual','ai_confirmed','mcp')), agent_id TEXT,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  UNIQUE(owner_id, idempotency_key), UNIQUE(owner_id, id),
  FOREIGN KEY(owner_id, category_id) REFERENCES categories(owner_id,id),
  FOREIGN KEY(owner_id, account_id) REFERENCES accounts(owner_id,id),
  FOREIGN KEY(owner_id, channel_id) REFERENCES channels(owner_id,id),
  FOREIGN KEY(owner_id, related_transaction_id) REFERENCES transactions(owner_id,id)
);
CREATE INDEX transactions_owner_occurred_idx ON transactions(owner_id, occurred_at) WHERE deleted_at IS NULL;
CREATE INDEX transactions_refund_idx ON transactions(owner_id, related_transaction_id) WHERE kind='refund' AND deleted_at IS NULL;
CREATE TABLE transaction_fx (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id), base_currency TEXT NOT NULL, rate TEXT NOT NULL,
  base_amount_minor INTEGER NOT NULL CHECK(base_amount_minor > 0), rate_date TEXT NOT NULL, rate_source TEXT NOT NULL, rate_kind TEXT NOT NULL
);
CREATE TABLE agent_credentials (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES profiles(id), agent_name TEXT NOT NULL,
  token_prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, permissions TEXT NOT NULL,
  expires_at TEXT, revoked_at TEXT, last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES profiles(id), actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
  operation TEXT NOT NULL, transaction_id TEXT, before_json TEXT, after_json TEXT, request_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX audit_owner_created_idx ON audit_events(owner_id, created_at);
CREATE TABLE ai_reports (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES profiles(id), period TEXT NOT NULL,
  filters_json TEXT NOT NULL, snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
  model TEXT NOT NULL, prompt_version TEXT NOT NULL, report_json TEXT NOT NULL, created_at TEXT NOT NULL
);
PRAGMA user_version = 1;
