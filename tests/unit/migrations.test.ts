import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations, assertMigrationsCurrent, latestSchemaVersion } from "@/db/migrations";
import { auditCiphertextDatabase } from "@/modules/vault/audit";

const directories: string[] = [];

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "ledger-migration-test-"));
  directories.push(directory);
  return new Database(join(directory, "ledger.db"));
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("database migrations", () => {
  it("applies and records ordered migrations on a fresh database", () => {
    const database = temporaryDatabase();
    const first = applyMigrations(database);
    const second = applyMigrations(database);
    expect(first).toEqual({ version: latestSchemaVersion, applied: [1, 2, 3, 4], baselined: false });
    expect(second).toEqual({ version: latestSchemaVersion, applied: [], baselined: false });
    expect(database.prepare("SELECT version,name FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 1, name: "initial" }, { version: 2, name: "vault_and_metadata" }, { version: 3, name: "analytics_fx" }, { version: 4, name: "ai" }]);
    expect(() => assertMigrationsCurrent(database)).not.toThrow();
    database.close();
  });

  it("baselines an existing v1 database without replaying destructive SQL", () => {
    const database = temporaryDatabase();
    database.exec(readFileSync("drizzle/0000_initial.sql", "utf8"));
    expect(applyMigrations(database)).toEqual({ version: latestSchemaVersion, applied: [2, 3, 4], baselined: true });
    expect(database.prepare("SELECT COUNT(*) count FROM schema_migrations").get()).toEqual({ count: 4 });
    database.close();
  });

  it("fails closed on migration checksum drift or a newer database", () => {
    const database = temporaryDatabase();
    applyMigrations(database);
    database.prepare("UPDATE schema_migrations SET checksum='tampered' WHERE version=1").run();
    expect(() => assertMigrationsCurrent(database)).toThrow("checksum");
    database.prepare("UPDATE schema_migrations SET checksum=(SELECT checksum FROM schema_migrations WHERE version=1) WHERE version=1").run();
    database.pragma("user_version = 99");
    expect(() => applyMigrations(database)).toThrow("newer than supported");
    database.close();
  });

  it("enforces payment-method ownership and audits a ciphertext-only copy", () => {
    const database = temporaryDatabase(); database.defaultSafeIntegers(true); applyMigrations(database); const now = new Date().toISOString(); const owner = "00000000-0000-4000-8000-0000000000e1"; const other = "00000000-0000-4000-8000-0000000000e2";
    for (const [id, subject] of [[owner, "one"], [other, "two"]]) database.prepare("INSERT INTO profiles (id,auth_subject,email,timezone,base_currency,enabled,created_at,updated_at) VALUES (?,?,?,'UTC','HKD',1,?,?)").run(id, subject, `${subject}@example.com`, now, now);
    database.prepare("INSERT INTO payment_methods (id,owner_id,name,sort_order,created_at,updated_at) VALUES ('method',?,'enc:method',0,?,?)").run(other, now, now);
    expect(() => database.prepare("INSERT INTO transactions (id,owner_id,kind,amount_minor,currency,occurred_at,occurred_timezone,time_precision,payment_method_id,source,idempotency_key,request_hash,created_at,updated_at) VALUES ('tx',?,'expense',1,'HKD',?,'UTC','minute','method','manual','key','hash',?,?)").run(owner, now, now, now)).toThrow("owner mismatch");
    database.prepare("DELETE FROM payment_methods").run(); database.prepare("DELETE FROM profiles WHERE id=?").run(other);
    database.prepare("INSERT INTO user_vaults (owner_id,key_version,kdf_salt,kdf_n,kdf_r,kdf_p,passphrase_envelope,recovery_envelope,created_at,updated_at) VALUES (?,1,'salt',131072,8,1,'{}','{}',?,?)").run(owner, now, now);
    database.prepare("INSERT INTO encrypted_entities (owner_id,entity_type,entity_id,key_version,nonce,ciphertext,tag,created_at,updated_at) VALUES (?,?,?,1,'1234567890123456','ciphertext','12345678901234567890',?,?)").run(owner, "profile", owner, now, now);
    database.prepare("INSERT INTO encrypted_entities (owner_id,entity_type,entity_id,key_version,nonce,ciphertext,tag,created_at,updated_at) VALUES (?,?,?,1,'1234567890123456','ciphertext','12345678901234567890',?,?)").run(owner, "ai_preferences", owner, now, now);
    database.prepare("INSERT INTO ai_preferences (owner_id,provider,enabled,consent_version,created_at,updated_at) VALUES (?,NULL,0,NULL,?,?)").run(owner, now, now);
    expect(auditCiphertextDatabase(database).ok).toBe(true);
    database.prepare("UPDATE profiles SET timezone='Asia/Hong_Kong' WHERE id=?").run(owner);
    expect(auditCiphertextDatabase(database).findings.find((item) => item.code === "PROFILE_PREFERENCES_NOT_REDACTED")?.count).toBe(1);
    database.close();
  });
});
