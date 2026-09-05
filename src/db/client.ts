import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { dirname, resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";

const globalDb = globalThis as unknown as { ledgerSqlite?: Database.Database };
const path = resolve(process.env.DATABASE_PATH ?? "./data/ledger.db");
mkdirSync(dirname(path), { recursive: true });

export const sqlite = globalDb.ledgerSqlite ?? new Database(path);
sqlite.defaultSafeIntegers(true);
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("synchronous = NORMAL");
const schemaVersion = Number(sqlite.pragma("user_version", { simple: true }));
if (schemaVersion < 1) sqlite.exec(readFileSync(resolve("drizzle/0000_initial.sql"), "utf8"));

if (process.env.NODE_ENV !== "production") globalDb.ledgerSqlite = sqlite;
export const db = drizzle(sqlite, { schema });
