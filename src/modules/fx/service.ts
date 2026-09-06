import { DateTime } from "luxon";
import { sqlite } from "@/db/client";
import type { ActorContext } from "@/modules/identity/types";
import { readEncryptedEntity, upsertEncryptedEntity } from "@/modules/vault/entities";
import { fetchHkmaRates, type HkmaRateSet } from "./hkma";
import { multiplyHalfUp, parseDecimal, rateViaHkd, type Rational } from "./rational";

export type FxTransaction = {
  id: string;
  kind: string;
  amount_minor: string;
  currency: string;
  occurred_at: string;
  occurred_timezone: string;
  related_transaction_id?: string | null;
};

export type FxSnapshot = {
  transaction_id: string;
  target_currency: string;
  source_date: string | null;
  source: string;
  rate_numerator: string | null;
  rate_denominator: string | null;
  base_amount_minor: string | null;
  status: "available" | "missing" | "stale";
};

const supported = new Set(["HKD", "CNY", "USD"]);
const snapshotId = (transactionId: string, targetCurrency: string) => `${transactionId}:${targetCurrency}`;

function encodeRational(value: Rational) {
  return `${value.numerator}/${value.denominator}`;
}

function decodeRational(value: string): Rational {
  const [numerator, denominator] = value.split("/");
  if (!numerator || !denominator) throw new Error("invalid cached rational");
  return { numerator: BigInt(numerator), denominator: BigInt(denominator) };
}

function cachedRates(requestedDate: string): HkmaRateSet | undefined {
  const date = sqlite.prepare("SELECT MAX(source_date) source_date FROM fx_rates WHERE source='hkma' AND source_date<=?").get(requestedDate) as { source_date: string | null };
  if (!date.source_date || date.source_date < DateTime.fromISO(requestedDate, { zone: "UTC" }).minus({ days: 10 }).toFormat("yyyy-MM-dd")) return undefined;
  const rows = sqlite.prepare("SELECT currency,rate_to_hkd,raw_hash FROM fx_rates WHERE source='hkma' AND source_date=?").all(date.source_date) as Array<{ currency: string; rate_to_hkd: string; raw_hash: string }>;
  const ratesToHkd = Object.fromEntries(rows.map((row) => [row.currency, decodeRational(row.rate_to_hkd)]));
  if (!ratesToHkd.USD || !ratesToHkd.CNY) return undefined;
  return { sourceDate: date.source_date, ratesToHkd, rawHash: rows[0]?.raw_hash ?? "" };
}

function saveRates(rateSet: HkmaRateSet) {
  const now = new Date().toISOString();
  for (const [currency, rate] of Object.entries(rateSet.ratesToHkd)) {
    sqlite.prepare("INSERT INTO fx_rates (source,source_date,currency,rate_to_hkd,fetched_at,raw_hash) VALUES ('hkma',?,?,?,?,?) ON CONFLICT(source,source_date,currency) DO UPDATE SET rate_to_hkd=excluded.rate_to_hkd,fetched_at=excluded.fetched_at,raw_hash=excluded.raw_hash")
      .run(rateSet.sourceDate, currency, encodeRational(rate), now, rateSet.rawHash);
  }
}

async function ratesForDate(date: string, fetcher: typeof fetchHkmaRates) {
  const cached = cachedRates(date);
  if (cached) return cached;
  const fetched = await fetcher(date);
  saveRates(fetched);
  return fetched;
}

export function readFxSnapshot(actor: ActorContext, transactionId: string, targetCurrency: string): FxSnapshot | undefined {
  const stored = readEncryptedEntity<FxSnapshot>(actor, "fx_snapshot", snapshotId(transactionId, targetCurrency));
  if (stored) return stored;
  const legacy = readEncryptedEntity<{ base_currency: string; rate: string; base_amount_minor: string | bigint; rate_date: string; rate_source: string }>(actor, "transaction_fx", transactionId);
  if (!legacy || legacy.base_currency !== targetCurrency) return undefined;
  const rate = parseDecimal(legacy.rate);
  return { transaction_id: transactionId, target_currency: targetCurrency, source_date: legacy.rate_date, source: legacy.rate_source, rate_numerator: rate.numerator.toString(), rate_denominator: rate.denominator.toString(), base_amount_minor: String(legacy.base_amount_minor), status: "available" };
}

function storeSnapshot(actor: ActorContext, value: FxSnapshot) {
  upsertEncryptedEntity(actor, "fx_snapshot", snapshotId(value.transaction_id, value.target_currency), value);
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO fx_snapshots (transaction_id,target_currency,source_date,source,rate,base_amount_minor,status,created_at,updated_at)
    VALUES (?,?,NULL,'encrypted',NULL,NULL,?,?,?)
    ON CONFLICT(transaction_id,target_currency) DO UPDATE SET source_date=NULL,source='encrypted',rate=NULL,base_amount_minor=NULL,status=excluded.status,updated_at=excluded.updated_at`)
    .run(value.transaction_id, value.target_currency, value.status, now, now);
}

function inheritedSnapshot(actor: ActorContext, transaction: FxTransaction, targetCurrency: string) {
  if (transaction.kind !== "refund" || !transaction.related_transaction_id) return undefined;
  const original = readFxSnapshot(actor, transaction.related_transaction_id, targetCurrency);
  if (!original || original.status !== "available" || !original.rate_numerator || !original.rate_denominator) return undefined;
  const rate = { numerator: BigInt(original.rate_numerator), denominator: BigInt(original.rate_denominator) };
  return { ...original, transaction_id: transaction.id, base_amount_minor: multiplyHalfUp(BigInt(transaction.amount_minor), rate).toString() } satisfies FxSnapshot;
}

export async function ensureFxSnapshot(
  actor: ActorContext,
  transaction: FxTransaction,
  targetCurrency: string,
  fetcher: typeof fetchHkmaRates = fetchHkmaRates,
) {
  const target = targetCurrency.toUpperCase();
  const source = transaction.currency.toUpperCase();
  if (!supported.has(source) || !supported.has(target) || source === target || transaction.kind === "transfer") return undefined;
  const existing = readFxSnapshot(actor, transaction.id, target);
  if (existing?.status === "available") return existing;
  const inherited = inheritedSnapshot(actor, transaction, target);
  if (inherited) { storeSnapshot(actor, inherited); return inherited; }

  const localDate = DateTime.fromISO(transaction.occurred_at, { setZone: true }).setZone(transaction.occurred_timezone).toFormat("yyyy-MM-dd");
  try {
    const rateSet = await ratesForDate(localDate, fetcher);
    const rate = rateViaHkd(source, target, rateSet.ratesToHkd);
    const snapshot: FxSnapshot = {
      transaction_id: transaction.id,
      target_currency: target,
      source_date: rateSet.sourceDate,
      source: "hkma",
      rate_numerator: rate.numerator.toString(),
      rate_denominator: rate.denominator.toString(),
      base_amount_minor: multiplyHalfUp(BigInt(transaction.amount_minor), rate).toString(),
      status: "available",
    };
    storeSnapshot(actor, snapshot);
    return snapshot;
  } catch {
    const missing: FxSnapshot = { transaction_id: transaction.id, target_currency: target, source_date: null, source: "hkma", rate_numerator: null, rate_denominator: null, base_amount_minor: null, status: "missing" };
    storeSnapshot(actor, missing);
    return missing;
  }
}

export async function ensureFxSnapshots(
  actor: ActorContext,
  transactions: FxTransaction[],
  targetCurrency: string,
  fetcher: typeof fetchHkmaRates = fetchHkmaRates,
) {
  const byId = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const ordered = [...transactions].sort((a, b) => Number(a.kind === "refund") - Number(b.kind === "refund"));
  for (const transaction of ordered) {
    if (transaction.kind === "refund" && transaction.related_transaction_id && !byId.has(transaction.related_transaction_id)) {
      const original = readEncryptedEntity<FxTransaction>(actor, "transaction", transaction.related_transaction_id);
      if (original) await ensureFxSnapshot(actor, original, targetCurrency, fetcher);
    }
    await ensureFxSnapshot(actor, transaction, targetCurrency, fetcher);
  }
}
