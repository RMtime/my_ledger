PRAGMA foreign_keys = ON;

CREATE TABLE fx_rates (
  source TEXT NOT NULL, source_date TEXT NOT NULL, currency TEXT NOT NULL, rate_to_hkd TEXT NOT NULL,
  fetched_at TEXT NOT NULL, raw_hash TEXT NOT NULL,
  PRIMARY KEY(source, source_date, currency)
);
CREATE TABLE fx_snapshots (
  transaction_id TEXT NOT NULL REFERENCES transactions(id), target_currency TEXT NOT NULL,
  source_date TEXT, source TEXT NOT NULL, rate TEXT, base_amount_minor INTEGER,
  status TEXT NOT NULL CHECK(status IN ('available','missing','stale')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(transaction_id, target_currency)
);

PRAGMA user_version = 3;
