import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DateTime } from "luxon";
import { sqlite } from "@/db/client";
import { AppError } from "@/modules/shared/errors";
import type { ActorContext } from "@/modules/identity/types";
import { createTransactionSchema, isoInstantSchema, transactionFiltersSchema, updateTransactionSchema, type CreateTransactionInput } from "./schemas";
import { convertHalfUp, isSupportedCurrency } from "./money";
import { blindIndex } from "@/modules/vault/crypto";
import { readEncryptedEntity, requireVaultKey, upsertEncryptedEntity, vaultInitialized } from "@/modules/vault/entities";
import { getProfile } from "@/modules/profile/service";

type Row = Record<string, unknown>;
type FxRow = {
  base_currency: string;
  rate: string;
  base_amount_minor: bigint;
  rate_date: string;
  rate_source: string;
  rate_kind: string;
};
type FxInput = NonNullable<CreateTransactionInput["fx"]>;
const maximumMinorAmount = 999_999_999_999_999n;
const fields = `t.id,t.kind,t.amount_minor,t.currency,t.occurred_at,t.occurred_timezone,t.time_precision,
  t.category_id,c.name category_name,t.payment_method,t.payment_method_id,pm.name payment_method_name,t.account_id,a.name account_name,t.channel_id,ch.name channel_name,
  t.merchant,t.note,t.related_transaction_id,t.transfer_group_id,t.transfer_direction,t.source,t.agent_id,
  t.idempotency_key,t.version,t.created_at,t.updated_at,t.deleted_at,
  CASE WHEN t.kind='expense' THEN t.amount_minor-COALESCE((SELECT SUM(r.amount_minor) FROM transactions r
    WHERE r.owner_id=t.owner_id AND r.related_transaction_id=t.id AND r.kind='refund' AND r.deleted_at IS NULL),0)
    ELSE 0 END refundable_minor`;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const now = () => new Date().toISOString();

function serialize(row: Row): Record<string, unknown>;
function serialize(row: Row | undefined): Record<string, unknown> | undefined;
function serialize(row: Row | undefined) {
  if (!row) return undefined;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? (key === "version" ? Number(value) : value.toString()) : value]));
}

function requirePermission(actor: ActorContext, permission: ActorContext["permissions"][number]) {
  if (!actor.permissions.includes(permission)) throw new AppError("FORBIDDEN", "当前凭证没有此操作权限", 403);
}

function secureMode(actor: ActorContext) {
  const enabled = vaultInitialized(actor.ownerId);
  if (enabled) requireVaultKey(actor);
  return enabled;
}

function assertOwnedReference(ownerId: string, table: "categories" | "accounts" | "channels", id?: string | null) {
  if (!id) return;
  const found = sqlite.prepare(`SELECT 1 FROM ${table} WHERE owner_id=? AND id=? AND archived_at IS NULL`).get(ownerId, id);
  if (!found) throw new AppError("NOT_FOUND", "引用对象不存在", 404);
}

function assertOwnedPaymentMethod(ownerId: string, id?: string | null) {
  if (!id) return;
  const found = sqlite.prepare("SELECT 1 FROM payment_methods WHERE owner_id=? AND id=? AND archived_at IS NULL").get(ownerId, id);
  if (!found) throw new AppError("NOT_FOUND", "支付方式不存在", 404);
}

function secureRelatedTransactions(actor: ActorContext, originalId: string, excludeId?: string) {
  const rows = sqlite.prepare("SELECT id FROM transactions WHERE owner_id=? AND related_transaction_id=? AND deleted_at IS NULL").all(actor.ownerId, originalId) as Array<{ id: string }>;
  return rows
    .filter((row) => row.id !== excludeId)
    .map((row) => readEncryptedEntity<Row>(actor, "transaction", row.id))
    .filter((row): row is Row => Boolean(row && row.kind === "refund" && !row.deleted_at));
}

function getOwned(ownerId: string, id: string, actor?: ActorContext) {
  const row = sqlite.prepare(`SELECT ${fields} FROM transactions t
    LEFT JOIN categories c ON c.owner_id=t.owner_id AND c.id=t.category_id
    LEFT JOIN accounts a ON a.owner_id=t.owner_id AND a.id=t.account_id
    LEFT JOIN channels ch ON ch.owner_id=t.owner_id AND ch.id=t.channel_id
    LEFT JOIN payment_methods pm ON pm.owner_id=t.owner_id AND pm.id=t.payment_method_id
    WHERE t.owner_id=? AND t.id=?`).get(ownerId, id) as Row | undefined;
  if (!row || !actor || !vaultInitialized(ownerId)) return row;
  const value = readEncryptedEntity<Row>(actor, "transaction", id);
  if (!value) throw new AppError("CONFLICT", "加密账目缺失，请运行数据审计", 409);
  const materialized = { ...row, ...value };
  materialized.amount_minor = BigInt(String(value.amount_minor));
  const category = value.category_id ? readEncryptedEntity<Row>(actor, "category", String(value.category_id)) : undefined;
  const account = value.account_id ? readEncryptedEntity<Row>(actor, "account", String(value.account_id)) : undefined;
  const channel = value.channel_id ? readEncryptedEntity<Row>(actor, "channel", String(value.channel_id)) : undefined;
  const payment = value.payment_method_id ? readEncryptedEntity<Row>(actor, "payment_method", String(value.payment_method_id)) : undefined;
  materialized.category_name = category?.name ?? null;
  materialized.account_name = account?.name ?? null;
  materialized.channel_name = channel?.name ?? null;
  materialized.payment_method_name = payment?.name ?? null;
  materialized.payment_method = value.payment_method ?? payment?.legacy_code ?? null;
  const refunded = secureRelatedTransactions(actor, id).reduce((sum, refund) => sum + BigInt(String(refund.amount_minor)), 0n);
  materialized.refundable_minor = value.kind === "expense" ? BigInt(String(value.amount_minor)) - refunded : 0n;
  return materialized;
}

function getFx(transactionId: string, actor?: ActorContext) {
  if (actor && vaultInitialized(actor.ownerId)) return readEncryptedEntity<FxRow>(actor, "transaction_fx", transactionId);
  return sqlite.prepare(`SELECT base_currency,rate,base_amount_minor,rate_date,rate_source,rate_kind
    FROM transaction_fx WHERE transaction_id=?`).get(transactionId) as FxRow | undefined;
}

function auditState(transaction: Row | undefined, fx: FxRow | undefined) {
  return { transaction: serialize(transaction), fx: serialize(fx as unknown as Row | undefined) ?? null };
}

function writeSecureAudit(actor: ActorContext, operation: string, transactionId: string, before?: unknown, after?: unknown) {
  const id = randomUUID(); const createdAt = now();
  sqlite.prepare("INSERT INTO audit_events (id,owner_id,actor_type,actor_id,operation,transaction_id,before_json,after_json,request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, actor.ownerId, actor.actorType, actor.actorId, "encrypted", transactionId, null, null, `enc:${id}`, createdAt);
  upsertEncryptedEntity(actor, "audit_event", id, { id, owner_id: actor.ownerId, actor_type: actor.actorType, actor_id: actor.actorId, operation, transaction_id: transactionId, before: before ?? null, after: after ?? null, request_id: actor.requestId, created_at: createdAt });
}

function ownerBaseCurrency(actor: ActorContext) {
  const profile = getProfile(actor) as { base_currency?: string } | undefined;
  if (!profile) throw new AppError("NOT_FOUND", "用户资料不存在", 404);
  return String(profile.base_currency ?? "HKD").toUpperCase();
}

function validatedFx(actor: ActorContext, currency: string, amountMinor: bigint, input: FxInput) {
  const baseCurrency = ownerBaseCurrency(actor);
  if (!isSupportedCurrency(currency) || !isSupportedCurrency(baseCurrency)) {
    throw new AppError("VALIDATION_ERROR", "折算快照只支持 HKD、CNY 和 USD", 422);
  }
  if (input.base_currency !== baseCurrency) {
    throw new AppError("VALIDATION_ERROR", `折算目标币种必须是用户本位币 ${baseCurrency}`, 422);
  }
  if (currency === baseCurrency) throw new AppError("VALIDATION_ERROR", "本位币账目不需要折算快照", 422);
  const baseAmountMinor = convertHalfUp(amountMinor, input.rate);
  if (baseAmountMinor <= 0n || baseAmountMinor > maximumMinorAmount) {
    throw new AppError("VALIDATION_ERROR", "折算后的金额超出允许范围", 422);
  }
  return { ...input, baseCurrency, baseAmountMinor };
}

function upsertFx(transactionId: string, fx: ReturnType<typeof validatedFx>, actor?: ActorContext) {
  if (actor && secureMode(actor)) {
    upsertEncryptedEntity(actor, "transaction_fx", transactionId, { transaction_id: transactionId, base_currency: fx.baseCurrency, rate: fx.rate, base_amount_minor: fx.baseAmountMinor.toString(), rate_date: fx.rate_date, rate_source: fx.rate_source, rate_kind: "manual" });
    const [whole, fraction = ""] = fx.rate.split(".");
    upsertEncryptedEntity(actor, "fx_snapshot", `${transactionId}:${fx.baseCurrency}`, {
      transaction_id: transactionId,
      target_currency: fx.baseCurrency,
      source_date: fx.rate_date,
      source: fx.rate_source,
      rate_numerator: (BigInt(whole) * (10n ** BigInt(fraction.length)) + BigInt(fraction || "0")).toString(),
      rate_denominator: (10n ** BigInt(fraction.length)).toString(),
      base_amount_minor: fx.baseAmountMinor.toString(),
      status: "available",
    });
    sqlite.prepare("UPDATE transaction_fx SET base_currency='XXX',rate='1',base_amount_minor=1,rate_date='1970-01-01',rate_source='encrypted',rate_kind='manual' WHERE transaction_id=?").run(transactionId);
    sqlite.prepare("INSERT INTO fx_snapshots (transaction_id,target_currency,source_date,source,rate,base_amount_minor,status,created_at,updated_at) VALUES (?,?,NULL,'encrypted',NULL,NULL,'available',?,?) ON CONFLICT(transaction_id,target_currency) DO UPDATE SET source_date=NULL,source='encrypted',rate=NULL,base_amount_minor=NULL,status='available',updated_at=excluded.updated_at").run(transactionId, fx.baseCurrency, new Date().toISOString(), new Date().toISOString());
    return;
  }
  sqlite.prepare(`INSERT INTO transaction_fx (transaction_id,base_currency,rate,base_amount_minor,rate_date,rate_source,rate_kind)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(transaction_id) DO UPDATE SET base_currency=excluded.base_currency,rate=excluded.rate,
      base_amount_minor=excluded.base_amount_minor,rate_date=excluded.rate_date,rate_source=excluded.rate_source,rate_kind=excluded.rate_kind`).run(
    transactionId,
    fx.baseCurrency,
    fx.rate,
    fx.baseAmountMinor,
    fx.rate_date,
    fx.rate_source,
    "manual",
  );
  sqlite.prepare("INSERT INTO fx_snapshots (transaction_id,target_currency,source_date,source,rate,base_amount_minor,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(transaction_id,target_currency) DO UPDATE SET source_date=excluded.source_date,source=excluded.source,rate=excluded.rate,base_amount_minor=excluded.base_amount_minor,status=excluded.status,updated_at=excluded.updated_at").run(transactionId, fx.baseCurrency, fx.rate_date, fx.rate_source, fx.rate, fx.baseAmountMinor, "available", new Date().toISOString(), new Date().toISOString());
}

function secureIdempotentTransaction(actor: ActorContext, idempotencyKey: string, requestHash: string) {
  const index = blindIndex(actor.vaultKey!, actor.ownerId, "transaction:idempotency", idempotencyKey);
  const row = sqlite.prepare("SELECT entity_id FROM encrypted_entities WHERE owner_id=? AND entity_type='transaction' AND blind_idempotency=?").get(actor.ownerId, index) as { entity_id: string } | undefined;
  if (!row) return undefined;
  const payload = readEncryptedEntity<Row>(actor, "transaction", row.entity_id);
  if (!payload || payload.request_hash !== requestHash) throw new AppError("IDEMPOTENCY_CONFLICT", "同一幂等键已用于不同内容", 409);
  return { transaction: serialize(getOwned(actor.ownerId, row.entity_id, actor)), deduplicated: true };
}

function createSecureTransferPair(actor: ActorContext, input: CreateTransactionInput, requestHash: string) {
  assertOwnedReference(actor.ownerId, "accounts", input.account_id);
  assertOwnedReference(actor.ownerId, "accounts", input.counterparty_account_id);
  const sourceAccount = input.account_id ? readEncryptedEntity<Row>(actor, "account", input.account_id) : undefined;
  const targetAccount = input.counterparty_account_id ? readEncryptedEntity<Row>(actor, "account", input.counterparty_account_id) : undefined;
  if (!sourceAccount || !targetAccount || sourceAccount.currency !== input.currency || targetAccount.currency !== input.currency) {
    throw new AppError("CONFLICT", "成组转账要求两个账户与账目币种相同", 409);
  }
  const duplicate = secureIdempotentTransaction(actor, input.idempotency_key, requestHash);
  if (duplicate) return duplicate;
  const groupId = randomUUID(); const outId = randomUUID(); const inId = randomUUID(); const timestamp = now();
  const insert = sqlite.prepare(`INSERT INTO transactions
    (id,owner_id,kind,amount_minor,currency,occurred_at,occurred_timezone,time_precision,account_id,transfer_group_id,transfer_direction,source,agent_id,idempotency_key,request_hash,version,created_at,updated_at)
    VALUES (?,?,'expense',1,'XXX','1970-01-01T00:00:00.000Z','UTC','date',?,?,?,?,?,?,?,?,?,?)`);
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const common = { ...input, owner_id: actor.ownerId, kind: "transfer", amount_minor: input.amount_minor, transfer_group_id: groupId, source: input.source, agent_id: actor.actorType === "agent" ? actor.actorId : null, request_hash: requestHash, version: 1, created_at: timestamp, updated_at: timestamp, deleted_at: null };
    insert.run(outId, actor.ownerId, input.account_id, groupId, "out", input.source, common.agent_id, `enc:${outId}`, blindIndex(actor.vaultKey!, actor.ownerId, "transaction:request", requestHash), 1, timestamp, timestamp);
    insert.run(inId, actor.ownerId, input.counterparty_account_id, groupId, "in", input.source, common.agent_id, `enc:${inId}`, blindIndex(actor.vaultKey!, actor.ownerId, "transaction:request", `${requestHash}:in`), 1, timestamp, timestamp);
    const indexes = (idempotency: string) => ({ month: DateTime.fromISO(input.occurred_at).setZone(input.occurred_timezone).toFormat("yyyy-MM"), kind: "transfer", currency: input.currency, idempotency });
    upsertEncryptedEntity(actor, "transaction", outId, { ...common, id: outId, account_id: input.account_id, counterparty_account_id: input.counterparty_account_id, transfer_direction: "out", idempotency_key: input.idempotency_key }, indexes(input.idempotency_key));
    upsertEncryptedEntity(actor, "transaction", inId, { ...common, id: inId, account_id: input.counterparty_account_id, counterparty_account_id: input.account_id, transfer_direction: "in", idempotency_key: `${input.idempotency_key}:in` }, indexes(`${input.idempotency_key}:in`));
    writeSecureAudit(actor, "transfer.create", outId, null, { transaction_ids: [outId, inId], transfer_group_id: groupId });
    sqlite.exec("COMMIT");
    const pair = [serialize(getOwned(actor.ownerId, outId, actor))!, serialize(getOwned(actor.ownerId, inId, actor))!];
    return { transaction: pair[0], pair, deduplicated: false };
  } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}

function createSecureTransaction(actor: ActorContext, input: CreateTransactionInput, requestHash: string) {
  if (input.kind === "transfer" && input.counterparty_account_id) return createSecureTransferPair(actor, input, requestHash);
  const duplicate = secureIdempotentTransaction(actor, input.idempotency_key, requestHash);
  if (duplicate) return duplicate;
  let response!: { transaction: ReturnType<typeof serialize>; deduplicated: boolean };
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const refundOriginal = input.kind === "refund" ? validateRefund(actor.ownerId, input, actor) : undefined;
    const categoryId = input.category_id ?? refundOriginal?.category_id ?? null;
    assertOwnedReference(actor.ownerId, "categories", categoryId as string | null);
    assertOwnedReference(actor.ownerId, "accounts", input.account_id);
    assertOwnedReference(actor.ownerId, "channels", input.channel_id);
    const paymentMethodId = input.payment_method_id ?? (input.payment_method ? (sqlite.prepare("SELECT id FROM payment_methods WHERE owner_id=? AND legacy_code=? AND archived_at IS NULL").get(actor.ownerId, input.payment_method) as { id: string } | undefined)?.id : null);
    assertOwnedPaymentMethod(actor.ownerId, paymentMethodId);
    const id = randomUUID(); const timestamp = now();
    const payload = { ...input, id, owner_id: actor.ownerId, category_id: categoryId, payment_method: input.payment_method ?? null, payment_method_id: paymentMethodId, account_id: input.account_id ?? null, channel_id: input.channel_id ?? null, related_transaction_id: input.related_transaction_id ?? null, agent_id: actor.actorType === "agent" ? actor.actorId : null, request_hash: requestHash, version: 1, created_at: timestamp, updated_at: timestamp, deleted_at: null, amount_minor: input.amount_minor };
    sqlite.prepare(`INSERT INTO transactions
      (id,owner_id,kind,amount_minor,currency,occurred_at,occurred_timezone,time_precision,category_id,payment_method,payment_method_id,account_id,channel_id,
       merchant,note,related_transaction_id,transfer_group_id,transfer_direction,source,agent_id,idempotency_key,request_hash,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, actor.ownerId, "expense", 1, "XXX", "1970-01-01T00:00:00.000Z", "UTC", "date", categoryId, null, paymentMethodId, input.account_id ?? null, input.channel_id ?? null,
      null, null, input.related_transaction_id ?? null, input.transfer_group_id ?? null, input.transfer_direction ?? null, input.source, actor.actorType === "agent" ? actor.actorId : null, `enc:${id}`, blindIndex(actor.vaultKey!, actor.ownerId, "transaction:request", requestHash), 1, timestamp, timestamp,
    );
    upsertEncryptedEntity(actor, "transaction", id, payload, { month: DateTime.fromISO(input.occurred_at).setZone(input.occurred_timezone).toFormat("yyyy-MM"), kind: input.kind, currency: input.currency, idempotency: input.idempotency_key });
    if (input.fx) upsertFx(id, validatedFx(actor, input.currency, BigInt(input.amount_minor), input.fx), actor);
    writeSecureAudit(actor, "transaction.create", id, null, payload);
    sqlite.exec("COMMIT"); response = { transaction: serialize(getOwned(actor.ownerId, id, actor)), deduplicated: false };
  } catch (error) {
    sqlite.exec("ROLLBACK");
    const code = (error as { code?: string }).code;
    if (code?.startsWith("SQLITE_CONSTRAINT_UNIQUE")) {
      const retry = secureIdempotentTransaction(actor, input.idempotency_key, requestHash);
      if (retry) return retry;
    }
    throw error;
  }
  return response;
}

export function createTransaction(actor: ActorContext, raw: unknown) {
  requirePermission(actor, "transactions:create");
  const parsed = createTransactionSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "账目字段不完整或格式不正确", 422, parsed.error.flatten());
  const input = parsed.data;
  const requestHash = hash(input);
  if (secureMode(actor)) return createSecureTransaction(actor, input, requestHash);
  const existing = sqlite.prepare("SELECT id, request_hash FROM transactions WHERE owner_id=? AND idempotency_key=?").get(actor.ownerId, input.idempotency_key) as { id: string; request_hash: string } | undefined;
  if (existing) {
    if (existing.request_hash !== requestHash) throw new AppError("IDEMPOTENCY_CONFLICT", "同一幂等键已用于不同内容", 409);
    return { transaction: serialize(getOwned(actor.ownerId, existing.id)), deduplicated: true };
  }
  if (input.kind === "transfer" && input.counterparty_account_id) return createTransferPair(actor, input, requestHash);

  let result!: { transaction: ReturnType<typeof serialize>; deduplicated: boolean };
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const refundOriginal = input.kind === "refund" ? validateRefund(actor.ownerId, input) : undefined;
    const categoryId = input.category_id ?? refundOriginal?.category_id;
    assertOwnedReference(actor.ownerId, "categories", input.category_id);
    assertOwnedReference(actor.ownerId, "accounts", input.account_id);
    assertOwnedReference(actor.ownerId, "channels", input.channel_id);
    const id = randomUUID();
    const timestamp = now();
    sqlite.prepare(`INSERT INTO transactions
      (id,owner_id,kind,amount_minor,currency,occurred_at,occurred_timezone,time_precision,category_id,payment_method,payment_method_id,account_id,channel_id,
       merchant,note,related_transaction_id,transfer_group_id,transfer_direction,source,agent_id,idempotency_key,request_hash,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, actor.ownerId, input.kind, BigInt(input.amount_minor), input.currency, input.occurred_at, input.occurred_timezone,
      input.time_precision, categoryId ?? null, input.payment_method ?? null, input.payment_method_id ?? null, input.account_id ?? null, input.channel_id ?? null,
      input.merchant ?? null, input.note ?? null, input.related_transaction_id ?? null, input.transfer_group_id ?? null, input.transfer_direction ?? null,
      input.source, actor.actorType === "agent" ? actor.actorId : null, input.idempotency_key, requestHash, 1, timestamp, timestamp,
    );
    if (input.fx) {
      upsertFx(id, validatedFx(actor, input.currency, BigInt(input.amount_minor), input.fx));
    }
    const created = serialize(getOwned(actor.ownerId, id));
    sqlite.prepare(`INSERT INTO audit_events (id,owner_id,actor_type,actor_id,operation,transaction_id,after_json,request_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(randomUUID(), actor.ownerId, actor.actorType, actor.actorId, "transaction.create", id, JSON.stringify(auditState(getOwned(actor.ownerId, id), getFx(id))), actor.requestId, timestamp);
    sqlite.exec("COMMIT");
    result = { transaction: created, deduplicated: false };
  } catch (error) {
    sqlite.exec("ROLLBACK");
    const code = (error as { code?: string }).code;
    if (code?.startsWith("SQLITE_CONSTRAINT_UNIQUE")) {
      const retry = sqlite.prepare("SELECT id, request_hash FROM transactions WHERE owner_id=? AND idempotency_key=?").get(actor.ownerId, input.idempotency_key) as { id: string; request_hash: string } | undefined;
      if (retry?.request_hash === requestHash) return { transaction: serialize(getOwned(actor.ownerId, retry.id)), deduplicated: true };
      throw new AppError("IDEMPOTENCY_CONFLICT", "同一幂等键已用于不同内容", 409);
    }
    throw error;
  }
  return result;
}

function createTransferPair(actor: ActorContext, input: CreateTransactionInput, requestHash: string) {
  let response!: { transaction: Record<string, unknown>; pair: Array<Record<string, unknown>>; deduplicated: boolean };
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    assertOwnedReference(actor.ownerId, "accounts", input.account_id); assertOwnedReference(actor.ownerId, "accounts", input.counterparty_account_id);
    const accounts = sqlite.prepare("SELECT id,currency FROM accounts WHERE owner_id=? AND id IN (?,?)").all(actor.ownerId,input.account_id,input.counterparty_account_id) as Array<{id:string;currency:string}>;
    if (accounts.length !== 2 || accounts.some(account=>account.currency!==input.currency)) throw new AppError("CONFLICT","首版成组转账要求两个账户与账目币种相同",409);
    const groupId=randomUUID(),outId=randomUUID(),inId=randomUUID(),timestamp=now();
    const insert=sqlite.prepare(`INSERT INTO transactions
      (id,owner_id,kind,amount_minor,currency,occurred_at,occurred_timezone,time_precision,account_id,note,transfer_group_id,transfer_direction,source,agent_id,idempotency_key,request_hash,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run(outId,actor.ownerId,"transfer",BigInt(input.amount_minor),input.currency,input.occurred_at,input.occurred_timezone,input.time_precision,input.account_id,input.note??null,groupId,"out",input.source,actor.actorType==="agent"?actor.actorId:null,input.idempotency_key,requestHash,1,timestamp,timestamp);
    insert.run(inId,actor.ownerId,"transfer",BigInt(input.amount_minor),input.currency,input.occurred_at,input.occurred_timezone,input.time_precision,input.counterparty_account_id,input.note??null,groupId,"in",input.source,actor.actorType==="agent"?actor.actorId:null,`${input.idempotency_key}:in`,requestHash,1,timestamp,timestamp);
    const pair=[serialize(getOwned(actor.ownerId,outId))!,serialize(getOwned(actor.ownerId,inId))!];
    sqlite.prepare(`INSERT INTO audit_events (id,owner_id,actor_type,actor_id,operation,transaction_id,after_json,request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(randomUUID(),actor.ownerId,actor.actorType,actor.actorId,"transfer.create",outId,JSON.stringify(pair),actor.requestId,timestamp);
    sqlite.exec("COMMIT"); response={transaction:pair[0],pair,deduplicated:false};
  } catch(error){
    sqlite.exec("ROLLBACK");
    const code = (error as { code?: string }).code;
    if (code?.startsWith("SQLITE_CONSTRAINT_UNIQUE")) {
      const retry = sqlite.prepare("SELECT id,request_hash FROM transactions WHERE owner_id=? AND idempotency_key=?").get(actor.ownerId,input.idempotency_key) as {id:string;request_hash:string}|undefined;
      if (retry?.request_hash === requestHash) {
        const transaction=serialize(getOwned(actor.ownerId,retry.id))!;
        const pair=sqlite.prepare(`SELECT ${fields} FROM transactions t
          LEFT JOIN categories c ON c.owner_id=t.owner_id AND c.id=t.category_id
          LEFT JOIN accounts a ON a.owner_id=t.owner_id AND a.id=t.account_id
          LEFT JOIN channels ch ON ch.owner_id=t.owner_id AND ch.id=t.channel_id
          LEFT JOIN payment_methods pm ON pm.owner_id=t.owner_id AND pm.id=t.payment_method_id
          WHERE t.owner_id=? AND t.transfer_group_id=? ORDER BY t.transfer_direction DESC`).all(actor.ownerId,transaction.transfer_group_id) as Row[];
        return {transaction,pair:pair.map((row)=>serialize(row)!),deduplicated:true};
      }
      throw new AppError("IDEMPOTENCY_CONFLICT","同一幂等键已用于不同内容",409);
    }
    throw error;
  }
  return response;
}

function validateRefund(ownerId: string, input: CreateTransactionInput, actor?: ActorContext) {
  const original = actor && secureMode(actor) ? getOwned(ownerId, String(input.related_transaction_id), actor) as Row | undefined : sqlite.prepare("SELECT kind, amount_minor, currency, category_id, deleted_at FROM transactions WHERE owner_id=? AND id=?").get(ownerId, input.related_transaction_id) as Row | undefined;
  if (!original || original.deleted_at) throw new AppError("NOT_FOUND", "原消费不存在", 404);
  if (original.kind !== "expense" || original.currency !== input.currency) throw new AppError("CONFLICT", "退款必须关联同币种消费", 409);
  const refunded = actor && secureMode(actor) ? secureRelatedTransactions(actor, String(input.related_transaction_id)).reduce((sum, row) => sum + BigInt(String(row.amount_minor)), 0n) : (sqlite.prepare("SELECT COALESCE(SUM(amount_minor),0) total FROM transactions WHERE owner_id=? AND related_transaction_id=? AND kind='refund' AND deleted_at IS NULL").get(ownerId, input.related_transaction_id) as { total: bigint }).total;
  if (refunded + BigInt(input.amount_minor) > BigInt(String(original.amount_minor))) throw new AppError("CONFLICT", "退款总额不能超过原消费", 409);
  return original;
}

export function getTransaction(actor: ActorContext, id: string) {
  requirePermission(actor, "transactions:read");
  const row = getOwned(actor.ownerId, id, actor);
  if (!row || row.deleted_at) throw new AppError("NOT_FOUND", "账目不存在", 404);
  return serialize(row);
}

// blind_month 是按每笔自己的 occurred_timezone 生成的，与 UTC 月份可能差一个月，
// 因此候选集在区间覆盖的 UTC 月份两侧各多取一个月。预筛只做粗筛，精确的
// occurred_at 比较仍然照旧执行，所以即使候选偏宽也不会影响结果。
function candidateRows(actor: ActorContext, start?: string, end?: string) {
  const { key } = requireVaultKey(actor);
  if (start && end) {
    const from = DateTime.fromISO(start, { zone: "UTC" }).minus({ months: 1 });
    const until = DateTime.fromISO(end, { zone: "UTC" }).plus({ months: 1 });
    if (from.isValid && until.isValid) {
      const months: string[] = [];
      for (let cursor = from.startOf("month"); cursor <= until; cursor = cursor.plus({ months: 1 })) {
        months.push(blindIndex(key, actor.ownerId, "transaction:month", cursor.toFormat("yyyy-MM")));
      }
      const placeholders = months.map(() => "?").join(",");
      // blind_month 为空的历史密文一律保留，宁可多解密也不能漏行。
      return sqlite.prepare(`SELECT t.id FROM transactions t
        JOIN encrypted_entities e ON e.owner_id=t.owner_id AND e.entity_type='transaction' AND e.entity_id=t.id
        WHERE t.owner_id=? AND t.deleted_at IS NULL AND (e.blind_month IS NULL OR e.blind_month IN (${placeholders}))`)
        .all(actor.ownerId, ...months) as Array<{ id: string }>;
    }
  }
  return sqlite.prepare("SELECT id FROM transactions WHERE owner_id=? AND deleted_at IS NULL").all(actor.ownerId) as Array<{ id: string }>;
}

function secureRows(actor: ActorContext, filters: z.infer<typeof transactionFiltersSchema>) {
  const start = filters.start ?? filters.date_from; const end = filters.end ?? filters.date_to;
  const baseRows = candidateRows(actor, start, end);
  let items = baseRows.map(({ id }) => getOwned(actor.ownerId, id, actor)).filter((row): row is Row => Boolean(row));
  items = items.filter((row) => (!start || String(row.occurred_at) >= start) && (!end || String(row.occurred_at) < end));
  if (filters.kind) items = items.filter((row) => row.kind === filters.kind);
  if (filters.currency) items = items.filter((row) => row.currency === filters.currency);
  if (filters.category_id) items = items.filter((row) => row.category_id === filters.category_id);
  if (filters.payment_method_id) items = items.filter((row) => row.payment_method_id === filters.payment_method_id);
  if (filters.payment_method) items = items.filter((row) => row.payment_method === filters.payment_method);
  if (filters.account_id) items = items.filter((row) => row.account_id === filters.account_id);
  if (filters.channel_id) items = items.filter((row) => row.channel_id === filters.channel_id);
  if (filters.search) { const search = filters.search.toLocaleLowerCase(); items = items.filter((row) => [row.merchant, row.note, row.category_name, row.account_name, row.channel_name, row.payment_method_name].some((value) => String(value ?? "").toLocaleLowerCase().includes(search))); }
  if (filters.refundable) items = items.filter((row) => row.kind === "expense" && BigInt(String(row.refundable_minor ?? 0)) > 0n);
  items.sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)) || String(b.id).localeCompare(String(a.id)));
  return items;
}

function listSecureTransactions(actor: ActorContext, filters: z.infer<typeof transactionFiltersSchema>) {
  let items = secureRows(actor, filters);
  if (filters.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8")) as unknown;
      if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") throw new Error("cursor");
      items = items.filter((row) => String(row.occurred_at) < decoded[0] || (String(row.occurred_at) === decoded[0] && String(row.id) < decoded[1]));
    } catch { throw new AppError("VALIDATION_ERROR", "分页 cursor 不正确", 422); }
  }
  const hasMore = items.length > filters.limit; const selected = items.slice(0, filters.limit).map(serialize); const last = selected.at(-1);
  return { items: selected, next_cursor: hasMore && last ? Buffer.from(JSON.stringify([String(last.occurred_at), String(last.id)])).toString("base64url") : null };
}

function updateSecureTransaction(actor: ActorContext, id: string, input: z.infer<typeof updateTransactionSchema>) {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const before = getOwned(actor.ownerId, id, actor);
    if (!before || before.deleted_at) throw new AppError("NOT_FOUND", "账目不存在", 404);
    if (Number(before.version) !== input.version) throw new AppError("VERSION_CONFLICT", "账目已在其他设备修改，请重新加载", 409);
    if (before.kind === "transfer" && before.transfer_group_id) throw new AppError("CONFLICT", "成组转账不能单独编辑，请撤销后重新创建", 409);
    const merged = { ...before, ...input } as Row;
    const paymentMethodId = (merged.payment_method_id as string | null | undefined) ?? (merged.payment_method ? (sqlite.prepare("SELECT id FROM payment_methods WHERE owner_id=? AND legacy_code=? AND archived_at IS NULL").get(actor.ownerId, merged.payment_method) as { id: string } | undefined)?.id : null);
    merged.payment_method_id = paymentMethodId;
    assertOwnedReference(actor.ownerId, "categories", merged.category_id as string | null); assertOwnedReference(actor.ownerId, "accounts", merged.account_id as string | null); assertOwnedReference(actor.ownerId, "channels", merged.channel_id as string | null); assertOwnedPaymentMethod(actor.ownerId, paymentMethodId);
    const refunded = secureRelatedTransactions(actor, id).reduce((sum, row) => sum + BigInt(String(row.amount_minor)), 0n);
    if (before.kind === "expense" && BigInt(String(merged.amount_minor)) < refunded) throw new AppError("CONFLICT", "消费金额不能低于已退款总额", 409);
    if (before.kind === "expense" && refunded > 0n && merged.currency !== before.currency) throw new AppError("CONFLICT", "已有退款的消费不能修改币种", 409);
    if (before.kind === "refund") {
      const original = before.related_transaction_id ? getOwned(actor.ownerId, String(before.related_transaction_id), actor) : undefined;
      const others = original ? secureRelatedTransactions(actor, String(original.id), id).reduce((sum, row) => sum + BigInt(String(row.amount_minor)), 0n) : 0n;
      if (!original || original.deleted_at || merged.currency !== original.currency || others + BigInt(String(merged.amount_minor)) > BigInt(String(original.amount_minor))) throw new AppError("CONFLICT", "退款总额不能超过原消费且必须保持同币种", 409);
    }
    const timestamp = now(); const nextVersion = Number(before.version) + 1; const amount = BigInt(String(merged.amount_minor));
    const payload = { ...before, ...input, id, owner_id: actor.ownerId, amount_minor: amount.toString(), version: nextVersion, updated_at: timestamp, deleted_at: null, payment_method: merged.payment_method ?? null, payment_method_id: merged.payment_method_id ?? null };
    const changed = sqlite.prepare(`UPDATE transactions SET kind='expense',amount_minor=1,currency='XXX',occurred_at='1970-01-01T00:00:00.000Z',occurred_timezone='UTC',time_precision='date',category_id=?,payment_method=NULL,payment_method_id=?,account_id=?,channel_id=?,merchant=NULL,note=NULL,version=version+1,updated_at=? WHERE owner_id=? AND id=? AND version=?`).run(
      merged.category_id ?? null, merged.payment_method_id ?? null, merged.account_id ?? null, merged.channel_id ?? null, timestamp, actor.ownerId, id, input.version,
    );
    if (!changed.changes) throw new AppError("VERSION_CONFLICT", "账目已在其他设备修改，请重新加载", 409);
    upsertEncryptedEntity(actor, "transaction", id, payload, { month: DateTime.fromISO(String(merged.occurred_at)).setZone(String(merged.occurred_timezone)).toFormat("yyyy-MM"), kind: String(merged.kind), currency: String(merged.currency), idempotency: String(before.idempotency_key) });
    if (input.fx) upsertFx(id, validatedFx(actor, String(merged.currency), amount, input.fx), actor);
    else if (input.amount_minor !== undefined || input.currency !== undefined || input.occurred_at !== undefined) {
      sqlite.prepare("DELETE FROM encrypted_entities WHERE owner_id=? AND entity_type='transaction_fx' AND entity_id=?").run(actor.ownerId, id);
      sqlite.prepare("DELETE FROM encrypted_entities WHERE owner_id=? AND entity_type='fx_snapshot' AND entity_id LIKE ?").run(actor.ownerId, `${id}:%`);
      sqlite.prepare("DELETE FROM transaction_fx WHERE transaction_id=?").run(id);
      sqlite.prepare("UPDATE fx_snapshots SET status='stale',source_date=NULL,source='encrypted',rate=NULL,base_amount_minor=NULL,updated_at=? WHERE transaction_id=?").run(new Date().toISOString(), id);
    }
    writeSecureAudit(actor, "transaction.update", id, before, payload);
    sqlite.exec("COMMIT"); return serialize(getOwned(actor.ownerId, id, actor));
  } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}

function deleteSecureTransaction(actor: ActorContext, id: string, version: number) {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const before = getOwned(actor.ownerId, id, actor);
    if (!before || before.deleted_at) throw new AppError("NOT_FOUND", "账目不存在", 404);
    if (Number(before.version) !== version) throw new AppError("VERSION_CONFLICT", "账目已在其他设备修改，请重新加载", 409);
    if (before.kind === "transfer" && before.transfer_group_id) {
      const timestamp = now();
      const siblings = sqlite.prepare("SELECT id FROM transactions WHERE owner_id=? AND transfer_group_id=? AND deleted_at IS NULL").all(actor.ownerId, before.transfer_group_id) as Array<{ id: string }>;
      for (const sibling of siblings) {
        const value = readEncryptedEntity<Row>(actor, "transaction", sibling.id);
        if (!value) throw new AppError("MIGRATION_NOT_READY", "成组转账密文不完整", 409);
        sqlite.prepare("UPDATE transactions SET deleted_at=?,updated_at=?,version=version+1 WHERE owner_id=? AND id=?").run(timestamp, timestamp, actor.ownerId, sibling.id);
        upsertEncryptedEntity(actor, "transaction", sibling.id, { ...value, deleted_at: timestamp, updated_at: timestamp, version: Number(value.version) + 1 }, { month: DateTime.fromISO(String(value.occurred_at)).setZone(String(value.occurred_timezone)).toFormat("yyyy-MM"), kind: "transfer", currency: String(value.currency), idempotency: String(value.idempotency_key) });
      }
      writeSecureAudit(actor, "transfer.delete", id, before, { deleted_at: timestamp });
      sqlite.exec("COMMIT");
      return;
    }
    if (before.kind === "expense" && secureRelatedTransactions(actor, id).length) throw new AppError("CONFLICT", "已有退款的消费不能直接删除", 409);
    const timestamp = now(); const nextVersion = version + 1; const payload = { ...before, version: nextVersion, deleted_at: timestamp, updated_at: timestamp };
    sqlite.prepare("UPDATE transactions SET deleted_at=?,updated_at=?,version=version+1 WHERE owner_id=? AND id=? AND version=?").run(timestamp, timestamp, actor.ownerId, id, version);
    upsertEncryptedEntity(actor, "transaction", id, payload, { month: DateTime.fromISO(String(before.occurred_at)).setZone(String(before.occurred_timezone)).toFormat("yyyy-MM"), kind: String(before.kind), currency: String(before.currency), idempotency: String(before.idempotency_key) });
    writeSecureAudit(actor, "transaction.delete", id, before, payload);
    sqlite.exec("COMMIT");
  } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}

// 聚合类调用方（统计、汇率补齐、导出）需要一次拿到区间内的全部账目。
// 走分页会让密文路径反复全量解密，复杂度退化成二次方。
// 这里不做 transactions:read 校验：调用方各自持有更合适的权限（例如统计只需 analytics:read），
// 且返回值只用于服务端聚合，不直接回给凭证持有者。
export function collectTransactions(actor: ActorContext, raw: unknown) {
  const parsed = transactionFiltersSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "筛选参数不正确", 422, parsed.error.flatten());
  if (secureMode(actor)) return secureRows(actor, parsed.data).map(serialize);
  const items: Array<ReturnType<typeof serialize>> = []; let cursor: string | null = null;
  do {
    const page = listPlainTransactions(actor, { ...parsed.data, limit: 100, cursor: cursor ?? undefined });
    items.push(...page.items); cursor = page.next_cursor;
  } while (cursor);
  return items;
}

export function listTransactions(actor: ActorContext, raw: unknown) {
  requirePermission(actor, "transactions:read");
  const parsed = transactionFiltersSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "筛选参数不正确", 422, parsed.error.flatten());
  const filters = parsed.data;
  if (secureMode(actor)) return listSecureTransactions(actor, filters);
  return listPlainTransactions(actor, filters);
}

function listPlainTransactions(actor: ActorContext, filters: z.infer<typeof transactionFiltersSchema>) {
  const clauses = ["t.owner_id=?", "t.deleted_at IS NULL"];
  const values: unknown[] = [actor.ownerId];
  const start = filters.start ?? filters.date_from;
  const end = filters.end ?? filters.date_to;
  for (const [column, value] of [["occurred_at >=", start], ["occurred_at <", end], ["kind =", filters.kind], ["currency =", filters.currency], ["category_id =", filters.category_id], ["payment_method =", filters.payment_method], ["payment_method_id =", filters.payment_method_id], ["account_id =", filters.account_id], ["channel_id =", filters.channel_id]] as const) {
    if (value) { clauses.push(`t.${column} ?`); values.push(value); }
  }
  if (filters.search) {
    const escaped = filters.search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    clauses.push(`(COALESCE(t.merchant,'') LIKE ? ESCAPE '\\' OR COALESCE(t.note,'') LIKE ? ESCAPE '\\'
      OR COALESCE(c.name,'') LIKE ? ESCAPE '\\' OR COALESCE(a.name,'') LIKE ? ESCAPE '\\'
      OR COALESCE(ch.name,'') LIKE ? ESCAPE '\\')`);
    const pattern = `%${escaped}%`;
    values.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (filters.refundable) {
    clauses.push("t.kind='expense'");
    clauses.push(`t.amount_minor>COALESCE((SELECT SUM(r.amount_minor) FROM transactions r
      WHERE r.owner_id=t.owner_id AND r.related_transaction_id=t.id AND r.kind='refund' AND r.deleted_at IS NULL),0)`);
  }
  if (filters.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8")) as unknown;
      if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[1] !== "string") throw new Error("invalid cursor");
      const cursorTime = isoInstantSchema.safeParse(decoded[0]);
      if (!cursorTime.success) throw new Error("invalid cursor time");
      clauses.push("(t.occurred_at < ? OR (t.occurred_at = ? AND t.id < ?))"); values.push(cursorTime.data, cursorTime.data, decoded[1]);
    } catch { throw new AppError("VALIDATION_ERROR", "分页 cursor 不正确", 422); }
  }
  values.push(filters.limit + 1);
  const rows = sqlite.prepare(`SELECT ${fields} FROM transactions t
    LEFT JOIN categories c ON c.owner_id=t.owner_id AND c.id=t.category_id
    LEFT JOIN accounts a ON a.owner_id=t.owner_id AND a.id=t.account_id
    LEFT JOIN channels ch ON ch.owner_id=t.owner_id AND ch.id=t.channel_id
    LEFT JOIN payment_methods pm ON pm.owner_id=t.owner_id AND pm.id=t.payment_method_id
    WHERE ${clauses.join(" AND ")} ORDER BY t.occurred_at DESC,t.id DESC LIMIT ?`).all(...values) as Row[];
  const hasMore = rows.length > filters.limit;
  const items = rows.slice(0, filters.limit).map(serialize);
  const last = items.at(-1);
  return { items, next_cursor: hasMore && last ? Buffer.from(JSON.stringify([String(last.occurred_at), String(last.id)])).toString("base64url") : null };
}

export function updateTransaction(actor: ActorContext, id: string, raw: unknown) {
  if (actor.actorType !== "user") throw new AppError("FORBIDDEN", "Agent 不能修改账目", 403);
  const parsed = updateTransactionSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "修改字段不正确", 422, parsed.error.flatten());
  if (secureMode(actor)) return updateSecureTransaction(actor, id, parsed.data);
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const before = getOwned(actor.ownerId, id, actor);
    if (!before || before.deleted_at) throw new AppError("NOT_FOUND", "账目不存在", 404);
    if (Number(before.version) !== parsed.data.version) throw new AppError("VERSION_CONFLICT", "账目已在其他设备修改，请重新加载", 409);
    const merged = { ...before, ...parsed.data } as Row;
    if (before.kind === "transfer" && before.transfer_group_id) throw new AppError("CONFLICT", "成组转账不能单独编辑，请撤销后重新创建", 409);
    assertOwnedReference(actor.ownerId, "categories", merged.category_id as string | null);
    assertOwnedReference(actor.ownerId, "accounts", merged.account_id as string | null);
    assertOwnedReference(actor.ownerId, "channels", merged.channel_id as string | null);
    if (before.kind === "expense") {
      const refunded = sqlite.prepare("SELECT COALESCE(SUM(amount_minor),0) total FROM transactions WHERE owner_id=? AND related_transaction_id=? AND kind='refund' AND deleted_at IS NULL").get(actor.ownerId, id) as { total: bigint };
      if (BigInt(String(merged.amount_minor)) < refunded.total) throw new AppError("CONFLICT", "消费金额不能低于已退款总额", 409);
      if (refunded.total > 0n && merged.currency !== before.currency) throw new AppError("CONFLICT", "已有退款的消费不能修改币种", 409);
    }
    if (before.kind === "refund") {
      const original = sqlite.prepare("SELECT amount_minor,currency,deleted_at FROM transactions WHERE owner_id=? AND id=? AND kind='expense'").get(actor.ownerId,before.related_transaction_id) as {amount_minor:bigint;currency:string;deleted_at:string|null}|undefined;
      if (!original || original.deleted_at) throw new AppError("NOT_FOUND", "原消费不存在", 404);
      const otherRefunds = sqlite.prepare("SELECT COALESCE(SUM(amount_minor),0) total FROM transactions WHERE owner_id=? AND related_transaction_id=? AND kind='refund' AND id<>? AND deleted_at IS NULL").get(actor.ownerId,before.related_transaction_id,id) as {total:bigint};
      if (merged.currency !== original.currency || otherRefunds.total + BigInt(String(merged.amount_minor)) > original.amount_minor) throw new AppError("CONFLICT", "退款总额不能超过原消费且必须保持同币种", 409);
    }
    const beforeFx = getFx(id, actor);
    const changed = sqlite.prepare(`UPDATE transactions SET kind=?,amount_minor=?,currency=?,occurred_at=?,occurred_timezone=?,time_precision=?,category_id=?,payment_method=?,account_id=?,channel_id=?,merchant=?,note=?,version=version+1,updated_at=? WHERE owner_id=? AND id=? AND version=?`).run(
      merged.kind, BigInt(String(merged.amount_minor)), merged.currency, merged.occurred_at, merged.occurred_timezone, merged.time_precision,
      merged.category_id ?? null, merged.payment_method ?? null, merged.account_id ?? null, merged.channel_id ?? null, merged.merchant ?? null, merged.note ?? null,
      now(), actor.ownerId, id, parsed.data.version,
    );
    if (!changed.changes) throw new AppError("VERSION_CONFLICT", "账目已在其他设备修改，请重新加载", 409);
    const amountChanged = parsed.data.amount_minor !== undefined && BigInt(parsed.data.amount_minor) !== BigInt(String(before.amount_minor));
    const currencyChanged = parsed.data.currency !== undefined && parsed.data.currency !== before.currency;
    const occurredAtChanged = parsed.data.occurred_at !== undefined && parsed.data.occurred_at !== before.occurred_at;
    if (parsed.data.fx) {
      upsertFx(id, validatedFx(actor, String(merged.currency), BigInt(String(merged.amount_minor)), parsed.data.fx));
    } else if (beforeFx && (amountChanged || currencyChanged || occurredAtChanged)) {
      const baseCurrency = ownerBaseCurrency(actor);
      if (String(merged.currency) === baseCurrency || currencyChanged || occurredAtChanged || beforeFx.base_currency !== baseCurrency) {
        sqlite.prepare("DELETE FROM transaction_fx WHERE transaction_id=?").run(id);
        sqlite.prepare("UPDATE fx_snapshots SET status='missing',rate=NULL,base_amount_minor=NULL,updated_at=? WHERE transaction_id=?").run(now(), id);
      } else {
        const baseAmountMinor = convertHalfUp(BigInt(String(merged.amount_minor)), beforeFx.rate);
        if (baseAmountMinor <= 0n || baseAmountMinor > maximumMinorAmount) throw new AppError("VALIDATION_ERROR", "折算后的金额超出允许范围", 422);
        sqlite.prepare("UPDATE transaction_fx SET base_amount_minor=? WHERE transaction_id=?").run(baseAmountMinor, id);
      }
    }
    const after = serialize(getOwned(actor.ownerId, id, actor));
    sqlite.prepare(`INSERT INTO audit_events (id,owner_id,actor_type,actor_id,operation,transaction_id,before_json,after_json,request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), actor.ownerId, actor.actorType, actor.actorId, "transaction.update", id, JSON.stringify(auditState(before, beforeFx)), JSON.stringify(auditState(getOwned(actor.ownerId, id, actor), getFx(id, actor))), actor.requestId, now());
    sqlite.exec("COMMIT");
    return after;
  } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}

export function deleteTransaction(actor: ActorContext, id: string, version: number) {
  if (actor.actorType !== "user") throw new AppError("FORBIDDEN", "Agent 不能撤销账目", 403);
  if (secureMode(actor)) return deleteSecureTransaction(actor, id, version);
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const before = getOwned(actor.ownerId, id);
    if (!before || before.deleted_at) throw new AppError("NOT_FOUND", "账目不存在", 404);
    if (Number(before.version) !== version) throw new AppError("VERSION_CONFLICT", "账目已在其他设备修改，请重新加载", 409);
    if (before.kind === "transfer" && before.transfer_group_id) {
      const timestamp=now();
      sqlite.prepare("UPDATE transactions SET deleted_at=?,updated_at=?,version=version+1 WHERE owner_id=? AND transfer_group_id=? AND deleted_at IS NULL").run(timestamp,timestamp,actor.ownerId,before.transfer_group_id);
      sqlite.prepare(`INSERT INTO audit_events (id,owner_id,actor_type,actor_id,operation,transaction_id,before_json,request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(randomUUID(),actor.ownerId,actor.actorType,actor.actorId,"transfer.delete",id,JSON.stringify(serialize(before)),actor.requestId,timestamp);
      sqlite.exec("COMMIT"); return;
    }
    if (before.kind === "expense") {
      const refunds = sqlite.prepare("SELECT COUNT(*) count FROM transactions WHERE owner_id=? AND related_transaction_id=? AND kind='refund' AND deleted_at IS NULL").get(actor.ownerId, id) as { count: number };
      if (refunds.count) throw new AppError("CONFLICT", "已有退款的消费不能直接删除", 409);
    }
    const timestamp = now();
    sqlite.prepare("UPDATE transactions SET deleted_at=?,updated_at=?,version=version+1 WHERE owner_id=? AND id=? AND version=?").run(timestamp, timestamp, actor.ownerId, id, version);
    sqlite.prepare(`INSERT INTO audit_events (id,owner_id,actor_type,actor_id,operation,transaction_id,before_json,request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), actor.ownerId, actor.actorType, actor.actorId, "transaction.delete", id, JSON.stringify(serialize(before)), actor.requestId, timestamp);
    sqlite.exec("COMMIT");
  } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}
