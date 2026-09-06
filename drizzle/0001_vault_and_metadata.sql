PRAGMA foreign_keys = ON;

CREATE TABLE user_vaults (
  owner_id TEXT PRIMARY KEY REFERENCES profiles(id),
  key_version INTEGER NOT NULL DEFAULT 1,
  kdf_salt TEXT NOT NULL, kdf_n INTEGER NOT NULL, kdf_r INTEGER NOT NULL, kdf_p INTEGER NOT NULL,
  passphrase_envelope TEXT NOT NULL, recovery_envelope TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE encrypted_entities (
  owner_id TEXT NOT NULL REFERENCES profiles(id), entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  key_version INTEGER NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL,
  blind_month TEXT, blind_kind TEXT, blind_currency TEXT, blind_name TEXT, blind_idempotency TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, entity_type, entity_id)
);
CREATE INDEX encrypted_entities_month_idx ON encrypted_entities(owner_id,entity_type,blind_month);
CREATE INDEX encrypted_entities_kind_idx ON encrypted_entities(owner_id,entity_type,blind_kind);
CREATE INDEX encrypted_entities_name_idx ON encrypted_entities(owner_id,entity_type,blind_name);
CREATE UNIQUE INDEX encrypted_entities_idempotency_uq ON encrypted_entities(owner_id,entity_type,blind_idempotency) WHERE blind_idempotency IS NOT NULL;

CREATE TABLE payment_methods (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES profiles(id), name TEXT NOT NULL,
  legacy_code TEXT, sort_order INTEGER NOT NULL DEFAULT 0, archived_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner_id,id), UNIQUE(owner_id,name), UNIQUE(owner_id,legacy_code)
);

ALTER TABLE accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN payment_method_id TEXT;
CREATE INDEX transactions_owner_payment_method_idx ON transactions(owner_id,payment_method_id);
CREATE TRIGGER transactions_payment_method_owner_insert
BEFORE INSERT ON transactions WHEN NEW.payment_method_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM payment_methods WHERE owner_id=NEW.owner_id AND id=NEW.payment_method_id)
BEGIN SELECT RAISE(ABORT, 'payment method owner mismatch'); END;
CREATE TRIGGER transactions_payment_method_owner_update
BEFORE UPDATE OF owner_id,payment_method_id ON transactions WHEN NEW.payment_method_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM payment_methods WHERE owner_id=NEW.owner_id AND id=NEW.payment_method_id)
BEGIN SELECT RAISE(ABORT, 'payment method owner mismatch'); END;

PRAGMA user_version = 2;
