import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertMigrationsCurrent } from "../src/db/migrations";
import { auditCiphertextDatabase } from "../src/modules/vault/audit";

const target = resolve(process.env.DATABASE_PATH ?? "./data/ledger.db");
const database = new Database(target, { readonly: true, fileMustExist: true });
database.defaultSafeIntegers(true); database.pragma("foreign_keys=ON");
try {
  assertMigrationsCurrent(database);
  const result = auditCiphertextDatabase(database);
  const markers = (process.env.KNOWN_PLAINTEXT_MARKERS ?? "").split(",").map((value) => value.trim()).filter((value) => value.length >= 4);
  const markerHits: Array<{ file: string; marker_index: number }> = [];
  for (const file of [target, `${target}-wal`, `${target}-shm`]) {
    let bytes: Buffer; try { bytes = readFileSync(file); } catch { continue; }
    markers.forEach((marker, markerIndex) => { if (bytes.includes(Buffer.from(marker))) markerHits.push({ file, marker_index: markerIndex }); });
  }
  const ok = result.ok && markerHits.length === 0;
  console.log(JSON.stringify({ database: target, checked_at: new Date().toISOString(), ok, findings: result.findings, known_plaintext_marker_hits: markerHits }, null, 2));
  if (!ok) process.exitCode = 2;
} finally { database.close(); }
