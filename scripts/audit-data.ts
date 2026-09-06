import Database from "better-sqlite3";
import { resolve } from "node:path";
import { assertMigrationsCurrent } from "../src/db/migrations";
import { convertHalfUp } from "../src/modules/ledger/money";
import { normalizeUtcInstant } from "../src/modules/shared/time";
import { auditCiphertextDatabase } from "../src/modules/vault/audit";

type IdRow = { id: string };
type FxRow = IdRow & { amount_minor: bigint; rate: string; base_amount_minor: bigint };

const target = resolve(process.env.DATABASE_PATH ?? "./data/ledger.db");
const database = new Database(target, { readonly: true, fileMustExist: true });
database.defaultSafeIntegers(true);
database.pragma("foreign_keys = ON");

function ids(sql: string) {
  return (database.prepare(sql).all() as IdRow[]).map((row) => row.id);
}

try {
  assertMigrationsCurrent(database);
  const vaultCount = Number((database.prepare("SELECT COUNT(*) count FROM user_vaults").get() as { count: number }).count);
  if (vaultCount > 0) {
    const secure = auditCiphertextDatabase(database);
    console.log(JSON.stringify({ database: target, checked_at: new Date().toISOString(), mode: "ciphertext", ...secure }, null, 2));
    if (!secure.ok) process.exitCode = 2;
  } else {
  const invalidRefundReferences = ids(`SELECT r.id
    FROM transactions r
    LEFT JOIN transactions original ON original.owner_id=r.owner_id AND original.id=r.related_transaction_id
    WHERE r.kind='refund' AND r.deleted_at IS NULL
      AND (original.id IS NULL OR original.deleted_at IS NOT NULL OR original.kind<>'expense' OR original.currency<>r.currency)
    ORDER BY r.id`);
  const overRefundedExpenses = ids(`SELECT original.id
    FROM transactions original
    JOIN transactions refund ON refund.owner_id=original.owner_id AND refund.related_transaction_id=original.id
      AND refund.kind='refund' AND refund.deleted_at IS NULL
    WHERE original.kind='expense'
    GROUP BY original.owner_id,original.id,original.amount_minor
    HAVING SUM(refund.amount_minor)>original.amount_minor
    ORDER BY original.id`);
  const mismatchedFxTargets = ids(`SELECT t.id
    FROM transaction_fx fx
    JOIN transactions t ON t.id=fx.transaction_id
    JOIN profiles p ON p.id=t.owner_id
    WHERE fx.base_currency<>p.base_currency OR t.currency=p.base_currency
    ORDER BY t.id`);
  const invalidTimes = (database.prepare("SELECT id,occurred_at FROM transactions ORDER BY id").all() as Array<IdRow & { occurred_at: string }>)
    .filter((row) => normalizeUtcInstant(row.occurred_at) !== row.occurred_at)
    .map((row) => row.id);
  const invalidOrStaleFx = (database.prepare(`SELECT t.id,t.amount_minor,fx.rate,fx.base_amount_minor
    FROM transaction_fx fx JOIN transactions t ON t.id=fx.transaction_id ORDER BY t.id`).all() as FxRow[])
    .filter((row) => {
      if (!/^\d+(?:\.\d{1,12})?$/.test(row.rate) || BigInt(row.rate.replace(".", "")) <= 0n) return true;
      return convertHalfUp(row.amount_minor, row.rate) !== row.base_amount_minor;
    })
    .map((row) => row.id);

  const findings = [
    { code: "INVALID_REFUND_REFERENCE", transaction_ids: invalidRefundReferences },
    { code: "OVER_REFUNDED_EXPENSE", transaction_ids: overRefundedExpenses },
    { code: "MISMATCHED_FX_TARGET", transaction_ids: mismatchedFxTargets },
    { code: "INVALID_OR_NON_CANONICAL_TIME", transaction_ids: invalidTimes },
    { code: "INVALID_OR_STALE_FX_AMOUNT", transaction_ids: invalidOrStaleFx },
  ].map((finding) => ({ ...finding, count: finding.transaction_ids.length, transaction_ids: finding.transaction_ids.slice(0, 100) }));
  const ok = findings.every((finding) => finding.count === 0);
  console.log(JSON.stringify({ database: target, checked_at: new Date().toISOString(), ok, findings }, null, 2));
  if (!ok) process.exitCode = 2;
  }
} finally {
  database.close();
}
