import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";

type Migration = {
  version: number;
  name: string;
  filename: string;
};

type AppliedMigration = {
  version: number | bigint;
  name: string;
  checksum: string;
};

const migrations: readonly Migration[] = [
  { version: 1, name: "initial", filename: "drizzle/0000_initial.sql" },
  { version: 2, name: "vault_and_metadata", filename: "drizzle/0001_vault_and_metadata.sql" },
  { version: 3, name: "analytics_fx", filename: "drizzle/0002_analytics_fx.sql" },
  { version: 4, name: "ai", filename: "drizzle/0003_ai.sql" },
];

const requiredV1Tables = [
  "profiles",
  "accounts",
  "categories",
  "channels",
  "transactions",
  "transaction_fx",
  "agent_credentials",
  "audit_events",
  "ai_reports",
] as const;
const requiredV2Tables = ["user_vaults", "encrypted_entities", "payment_methods"] as const;
const requiredV3Tables = ["fx_rates", "fx_snapshots"] as const;
const requiredV4Tables = ["ai_preferences", "ai_invocations"] as const;

export const latestSchemaVersion = migrations.at(-1)?.version ?? 0;

function migrationSql(migration: Migration) {
  return readFileSync(resolve(migration.filename), "utf8");
}

function migrationChecksum(migration: Migration) {
  return createHash("sha256").update(migrationSql(migration)).digest("hex");
}

function tableExists(database: Database.Database, table: string) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function userTables(database: Database.Database) {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations'").all() as Array<{ name: string }>).map((row) => row.name);
}

function ensureMigrationLedger(database: Database.Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

function assertIntegrity(database: Database.Database) {
  const integrity = String(database.pragma("integrity_check", { simple: true }));
  if (integrity !== "ok") throw new Error(`Database integrity check failed: ${integrity}`);
}

function assertRequiredTables(database: Database.Database, version: number) {
  if (version < 1) return;
  const missing: string[] = requiredV1Tables.filter((table) => !tableExists(database, table));
  if (version >= 2) missing.push(...requiredV2Tables.filter((table) => !tableExists(database, table)));
  if (version >= 3) missing.push(...requiredV3Tables.filter((table) => !tableExists(database, table)));
  if (version >= 4) missing.push(...requiredV4Tables.filter((table) => !tableExists(database, table)));
  if (missing.length) throw new Error(`Schema v${version} is missing required tables: ${missing.join(", ")}`);
}

function readApplied(database: Database.Database): AppliedMigration[] {
  if (!tableExists(database, "schema_migrations")) return [];
  return database.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all() as AppliedMigration[];
}

function assertKnownHistory(database: Database.Database, currentVersion: number) {
  const applied = readApplied(database);
  for (const row of applied) {
    const version = Number(row.version);
    const expected = migrations.find((migration) => migration.version === version);
    if (!expected) throw new Error(`Database contains unknown migration v${version}`);
    if (row.name !== expected.name || row.checksum !== migrationChecksum(expected)) {
      throw new Error(`Migration v${version} checksum or name does not match this release`);
    }
    if (version > currentVersion) throw new Error(`Migration ledger v${version} is ahead of PRAGMA user_version v${currentVersion}`);
  }
  for (const migration of migrations.filter((item) => item.version <= currentVersion)) {
    if (!applied.some((row) => Number(row.version) === migration.version)) {
      throw new Error(`Migration ledger is missing v${migration.version}`);
    }
  }
}

export function migrationStatus(database: Database.Database) {
  const currentVersion = Number(database.pragma("user_version", { simple: true }));
  const recordedVersions = new Set(readApplied(database).map((row) => Number(row.version)));
  return {
    currentVersion,
    current: currentVersion === latestSchemaVersion && migrations.every((migration) => recordedVersions.has(migration.version)),
    hasBusinessSchema: userTables(database).length > 0,
  };
}

export function applyMigrations(database: Database.Database) {
  database.pragma("foreign_keys = ON");
  assertIntegrity(database);
  let currentVersion = Number(database.pragma("user_version", { simple: true }));
  if (currentVersion > latestSchemaVersion) {
    throw new Error(`Database schema v${currentVersion} is newer than supported v${latestSchemaVersion}`);
  }
  if (currentVersion === 0 && userTables(database).length > 0) {
    throw new Error("Refusing to migrate a non-empty database without PRAGMA user_version");
  }

  ensureMigrationLedger(database);
  const applied: number[] = [];
  let baselined = false;

  if (currentVersion > 0 && readApplied(database).length === 0) {
    assertRequiredTables(database, currentVersion);
    const baseline = database.transaction(() => {
      for (const migration of migrations.filter((item) => item.version <= currentVersion)) {
        database.prepare("INSERT INTO schema_migrations (version,name,checksum,applied_at) VALUES (?,?,?,?)").run(
          migration.version,
          migration.name,
          migrationChecksum(migration),
          new Date().toISOString(),
        );
      }
    });
    baseline();
    baselined = true;
  }

  assertKnownHistory(database, currentVersion);
  for (const migration of migrations.filter((item) => item.version > currentVersion)) {
    const run = database.transaction(() => {
      database.exec(migrationSql(migration));
      const resultingVersion = Number(database.pragma("user_version", { simple: true }));
      if (resultingVersion !== migration.version) {
        throw new Error(`Migration ${migration.filename} must set PRAGMA user_version=${migration.version}`);
      }
      database.prepare("INSERT INTO schema_migrations (version,name,checksum,applied_at) VALUES (?,?,?,?)").run(
        migration.version,
        migration.name,
        migrationChecksum(migration),
        new Date().toISOString(),
      );
    });
    run();
    currentVersion = migration.version;
    applied.push(migration.version);
  }

  assertRequiredTables(database, currentVersion);
  assertKnownHistory(database, currentVersion);
  const foreignKeyFailures = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyFailures.length) throw new Error(`Database foreign key check failed with ${foreignKeyFailures.length} violation(s)`);
  assertIntegrity(database);
  return { version: currentVersion, applied, baselined };
}

export function assertMigrationsCurrent(database: Database.Database) {
  const currentVersion = Number(database.pragma("user_version", { simple: true }));
  if (currentVersion !== latestSchemaVersion) {
    throw new Error(`Database schema v${currentVersion} is not current; run npm run db:migrate for v${latestSchemaVersion}`);
  }
  assertRequiredTables(database, currentVersion);
  assertKnownHistory(database, currentVersion);
}
