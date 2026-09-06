import Database from "better-sqlite3";
import { mkdirSync, renameSync, statSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertMigrationsCurrent } from "../src/db/migrations";
import { auditCiphertextDatabase } from "../src/modules/vault/audit";

const target = resolve(process.env.DATABASE_PATH ?? "./data/ledger.db");
const directory = dirname(target); const stamp = new Date().toISOString().replaceAll(":", "-");
const backupDirectory = resolve(process.env.MIGRATION_BACKUP_DIR ?? `${directory}/migration-backups`); mkdirSync(backupDirectory, { recursive: true });
const backup = resolve(backupDirectory, `pre-ciphertext-cutover-${stamp}.db`); const candidate = resolve(directory, `.ledger-ciphertext-${stamp}.db`); const isolatedOriginal = resolve(backupDirectory, `isolated-plaintext-${stamp}.db`);
const sourceBytes = statSync(target).size; const availableBytes = statfsSync(directory).bavail * statfsSync(directory).bsize;
if (availableBytes < sourceBytes * 3) throw new Error("Secure cutover requires free disk space for two verified database copies");

const source = new Database(target, { fileMustExist: true }); source.defaultSafeIntegers(true); source.pragma("foreign_keys=ON"); source.pragma("busy_timeout=5000"); source.pragma("locking_mode=EXCLUSIVE");
try {
  source.exec("BEGIN EXCLUSIVE"); assertMigrationsCurrent(source); const before = auditCiphertextDatabase(source); if (!before.ok) throw new Error(`Ciphertext audit failed: ${JSON.stringify(before.findings.filter((item) => item.count))}`); source.exec("COMMIT");
  source.pragma("wal_checkpoint(TRUNCATE)");
  await source.backup(backup); await source.backup(candidate);
} catch (error) { if (source.inTransaction) source.exec("ROLLBACK"); throw error; }
finally { source.close(); }

for (const file of [backup, candidate]) {
  const copy = new Database(file, { readonly: true, fileMustExist: true }); copy.defaultSafeIntegers(true); copy.pragma("foreign_keys=ON");
  try { assertMigrationsCurrent(copy); const audit = auditCiphertextDatabase(copy); if (!audit.ok) throw new Error(`Copied database failed ciphertext audit: ${file}`); }
  finally { copy.close(); }
}

renameSync(target, isolatedOriginal);
try { renameSync(candidate, target); }
catch (error) { renameSync(isolatedOriginal, target); throw error; }
console.log(JSON.stringify({ database: target, verified_backup: backup, isolated_original: isolatedOriginal, switched_at: new Date().toISOString(), original_deleted: false }, null, 2));
