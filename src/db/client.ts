import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { applyMigrations, assertMigrationsCurrent } from "./migrations";

const globalDb = globalThis as unknown as { ledgerSqlite?: Database.Database };
const isProductionBuild = process.env.NEXT_PHASE === "phase-production-build";
const path = isProductionBuild ? ":memory:" : resolve(process.env.DATABASE_PATH ?? "./data/ledger.db");
if (!isProductionBuild) mkdirSync(dirname(path), { recursive: true });

export const sqlite = globalDb.ledgerSqlite ?? new Database(path);
sqlite.defaultSafeIntegers(true);
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("synchronous = NORMAL");
if (!isProductionBuild) {
  if (process.env.NODE_ENV === "production") assertMigrationsCurrent(sqlite);
  else applyMigrations(sqlite);
}

if (process.env.NODE_ENV !== "production") globalDb.ledgerSqlite = sqlite;
export const db = drizzle(sqlite, { schema });
