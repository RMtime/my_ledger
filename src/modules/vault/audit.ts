import type Database from "better-sqlite3";

export type SecureAuditFinding = { code: string; count: number; sample_ids: string[] };

function finding(database: Database.Database, code: string, sql: string, ...params: unknown[]): SecureAuditFinding {
  const rows = database.prepare(sql).all(...params) as Array<{ id: string }>;
  return { code, count: rows.length, sample_ids: rows.slice(0, 20).map((row) => String(row.id)) };
}

export function auditCiphertextDatabase(database: Database.Database) {
  const findings = [
    finding(database, "PROFILE_WITHOUT_VAULT", "SELECT id FROM profiles p WHERE NOT EXISTS (SELECT 1 FROM user_vaults v WHERE v.owner_id=p.id)"),
    finding(database, "PROFILE_WITHOUT_CIPHERTEXT", "SELECT id FROM profiles p WHERE NOT EXISTS (SELECT 1 FROM encrypted_entities e WHERE e.owner_id=p.id AND e.entity_type='profile' AND e.entity_id=p.id)"),
    finding(database, "AI_PREFERENCE_WITHOUT_CIPHERTEXT", "SELECT id FROM profiles p WHERE NOT EXISTS (SELECT 1 FROM encrypted_entities e WHERE e.owner_id=p.id AND e.entity_type='ai_preferences' AND e.entity_id=p.id)"),
    finding(database, "TRANSACTION_WITHOUT_CIPHERTEXT", "SELECT id FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM encrypted_entities e WHERE e.owner_id=t.owner_id AND e.entity_type='transaction' AND e.entity_id=t.id)"),
    finding(database, "ACCOUNT_WITHOUT_CIPHERTEXT", "SELECT id FROM accounts a WHERE NOT EXISTS (SELECT 1 FROM encrypted_entities e WHERE e.owner_id=a.owner_id AND e.entity_type='account' AND e.entity_id=a.id)"),
    finding(database, "CATEGORY_WITHOUT_CIPHERTEXT", "SELECT id FROM categories c WHERE NOT EXISTS (SELECT 1 FROM encrypted_entities e WHERE e.owner_id=c.owner_id AND e.entity_type='category' AND e.entity_id=c.id)"),
    finding(database, "CHANNEL_WITHOUT_CIPHERTEXT", "SELECT id FROM channels c WHERE NOT EXISTS (SELECT 1 FROM encrypted_entities e WHERE e.owner_id=c.owner_id AND e.entity_type='channel' AND e.entity_id=c.id)"),
    finding(database, "PAYMENT_WITHOUT_CIPHERTEXT", "SELECT id FROM payment_methods p WHERE NOT EXISTS (SELECT 1 FROM encrypted_entities e WHERE e.owner_id=p.owner_id AND e.entity_type='payment_method' AND e.entity_id=p.id)"),
    finding(database, "AUDIT_WITHOUT_CIPHERTEXT", "SELECT id FROM audit_events a WHERE NOT EXISTS (SELECT 1 FROM encrypted_entities e WHERE e.owner_id=a.owner_id AND e.entity_type='audit_event' AND e.entity_id=a.id)"),
    finding(database, "AI_REPORT_WITHOUT_CIPHERTEXT", "SELECT id FROM ai_reports a WHERE NOT EXISTS (SELECT 1 FROM encrypted_entities e WHERE e.owner_id=a.owner_id AND e.entity_type='ai_report' AND e.entity_id=a.id)"),
    finding(database, "TRANSACTION_PLAINTEXT_NOT_REDACTED", "SELECT id FROM transactions WHERE kind<>'expense' OR amount_minor<>1 OR currency<>'XXX' OR occurred_at<>'1970-01-01T00:00:00.000Z' OR occurred_timezone<>'UTC' OR time_precision<>'date' OR merchant IS NOT NULL OR note IS NOT NULL OR idempotency_key<>('enc:'||id)"),
    finding(database, "PROFILE_PREFERENCES_NOT_REDACTED", "SELECT id FROM profiles WHERE timezone<>'UTC' OR base_currency<>'HKD'"),
    finding(database, "ACCOUNT_PLAINTEXT_NOT_REDACTED", "SELECT id FROM accounts WHERE name<>('enc:'||id) OR type<>'other' OR currency<>'XXX'"),
    finding(database, "CATEGORY_PLAINTEXT_NOT_REDACTED", "SELECT id FROM categories WHERE name<>('enc:'||id) OR transaction_kind<>'expense'"),
    finding(database, "CHANNEL_PLAINTEXT_NOT_REDACTED", "SELECT id FROM channels WHERE name<>('enc:'||id)"),
    finding(database, "PAYMENT_PLAINTEXT_NOT_REDACTED", "SELECT id FROM payment_methods WHERE name<>('enc:'||id)"),
    finding(database, "AUDIT_PLAINTEXT_NOT_REDACTED", "SELECT id FROM audit_events WHERE operation<>'encrypted' OR before_json IS NOT NULL OR after_json IS NOT NULL OR request_id<>('enc:'||id)"),
    finding(database, "AI_REPORT_PLAINTEXT_NOT_REDACTED", "SELECT id FROM ai_reports WHERE (period<>('enc:'||id) AND period<>'encrypted') OR filters_json<>'{}' OR snapshot_json<>'{}' OR report_json<>'{}' OR model<>'encrypted' OR prompt_version<>'encrypted' OR snapshot_hash<>('enc:'||id)"),
    finding(database, "AI_PREFERENCE_PLAINTEXT_NOT_REDACTED", "SELECT owner_id id FROM ai_preferences WHERE provider IS NOT NULL OR enabled<>0 OR consent_version IS NOT NULL"),
    finding(database, "LEGACY_FX_PLAINTEXT_NOT_REDACTED", "SELECT transaction_id id FROM transaction_fx WHERE base_currency<>'XXX' OR rate<>'1' OR base_amount_minor<>1 OR rate_date<>'1970-01-01' OR rate_source<>'encrypted'"),
    finding(database, "FX_SNAPSHOT_PLAINTEXT_NOT_REDACTED", "SELECT transaction_id||':'||target_currency id FROM fx_snapshots WHERE source_date IS NOT NULL OR rate IS NOT NULL OR base_amount_minor IS NOT NULL OR source<>'encrypted'"),
    finding(database, "INVALID_ENCRYPTED_ENVELOPE", "SELECT entity_type||':'||entity_id id FROM encrypted_entities WHERE key_version<1 OR length(nonce)<16 OR length(tag)<20 OR length(ciphertext)<1"),
  ];
  const foreignKeys = database.pragma("foreign_key_check") as Array<{ table: string; rowid: number | bigint }>;
  if (foreignKeys.length) findings.push({ code: "FOREIGN_KEY_FAILURE", count: foreignKeys.length, sample_ids: foreignKeys.slice(0, 20).map((row) => `${row.table}:${row.rowid}`) });
  const integrity = String(database.pragma("integrity_check", { simple: true }));
  if (integrity !== "ok") findings.push({ code: "INTEGRITY_FAILURE", count: 1, sample_ids: [integrity] });
  return { ok: findings.every((item) => item.count === 0), findings };
}
