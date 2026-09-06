import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { applyMigrations, migrationStatus } from "../src/db/migrations";

const target = resolve(process.env.DATABASE_PATH ?? "./data/ledger.db");
mkdirSync(dirname(target), { recursive: true });
const database = new Database(target);
database.defaultSafeIntegers(true);
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");

try {
  const before = migrationStatus(database);
  let backup: string | null = null;
  if (!before.current && before.hasBusinessSchema) {
    const backupDirectory = resolve(process.env.MIGRATION_BACKUP_DIR ?? `${dirname(target)}/migration-backups`);
    mkdirSync(backupDirectory, { recursive: true });
    backup = resolve(backupDirectory, `pre-migrate-v${before.currentVersion}-${new Date().toISOString().replaceAll(":", "-")}.db`);
    await database.backup(backup);
    const restored = new Database(backup, { readonly: true });
    const integrity = String(restored.pragma("integrity_check", { simple: true }));
    restored.close();
    if (integrity !== "ok") throw new Error(`Migration backup integrity failed: ${integrity}`);
  }
  const result = applyMigrations(database);
  console.log(JSON.stringify({ database: target, backup, ...result }, null, 2));
} finally {
  database.close();
}
