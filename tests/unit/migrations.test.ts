import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations, assertMigrationsCurrent, latestSchemaVersion } from "@/db/migrations";

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
    expect(first).toEqual({ version: latestSchemaVersion, applied: [1], baselined: false });
    expect(second).toEqual({ version: latestSchemaVersion, applied: [], baselined: false });
    expect(database.prepare("SELECT version,name FROM schema_migrations").all()).toEqual([{ version: 1, name: "initial" }]);
    expect(() => assertMigrationsCurrent(database)).not.toThrow();
    database.close();
  });

  it("baselines an existing v1 database without replaying destructive SQL", () => {
    const database = temporaryDatabase();
    database.exec(readFileSync("drizzle/0000_initial.sql", "utf8"));
    expect(applyMigrations(database)).toEqual({ version: 1, applied: [], baselined: true });
    expect(database.prepare("SELECT COUNT(*) count FROM schema_migrations").get()).toEqual({ count: 1 });
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
});
