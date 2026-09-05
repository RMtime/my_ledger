import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const target = resolve(process.env.DATABASE_PATH ?? "./data/ledger.db");
mkdirSync(dirname(target), { recursive: true });
const database = new Database(target);
database.pragma("foreign_keys = ON");
const version = database.pragma("user_version", { simple: true }) as number;
if (version < 1) database.exec(readFileSync(resolve("drizzle/0000_initial.sql"), "utf8"));
database.close();
console.log(`Database ready at ${target} (schema v${Math.max(version, 1)})`);
