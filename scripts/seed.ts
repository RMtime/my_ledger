import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed production");
const ownerId = process.env.LOCAL_DEV_OWNER_ID ?? "00000000-0000-4000-8000-000000000001";
const now = new Date().toISOString();
const database = new Database(resolve(process.env.DATABASE_PATH ?? "./data/ledger.db"));
database.pragma("foreign_keys = ON");
const run = database.transaction(() => {
  database.prepare(`INSERT OR IGNORE INTO profiles
    (id,auth_subject,email,timezone,base_currency,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(ownerId, `local:${ownerId}`, "local@example.invalid", "Asia/Hong_Kong", "HKD", 1, now, now);
  const categories = [["餐饮","expense"],["交通","expense"],["购物","expense"],["居住","expense"],["娱乐","expense"],["工资","income"],["其他收入","income"]];
  for (const [name, kind] of categories) database.prepare(`INSERT OR IGNORE INTO categories
    (id,owner_id,name,transaction_kind,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(randomUUID(), ownerId, name, kind, now, now);
  for (const name of ["线下","美团","淘宝","App Store"]) database.prepare(`INSERT OR IGNORE INTO channels
    (id,owner_id,name,created_at,updated_at) VALUES (?,?,?,?,?)`).run(randomUUID(), ownerId, name, now, now);
});
run();
database.close();
console.log("Local profile and metadata seeded; no sample transactions were created.");
