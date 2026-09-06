import { createHash, randomUUID } from "node:crypto";
import { sqlite } from "@/db/client";
import { AppError } from "@/modules/shared/errors";
import type { ActorContext } from "@/modules/identity/types";
import { createTransactionSchema, isoInstantSchema, transactionFiltersSchema, updateTransactionSchema, type CreateTransactionInput } from "./schemas";
import { convertHalfUp, isSupportedCurrency } from "./money";

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
  t.category_id,c.name category_name,t.payment_method,t.account_id,a.name account_name,t.channel_id,ch.name channel_name,
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

function assertOwnedReference(ownerId: string, table: "categories" | "accounts" | "channels", id?: string | null) {
  if (!id) return;
  const found = sqlite.prepare(`SELECT 1 FROM ${table} WHERE owner_id=? AND id=? AND archived_at IS NULL`).get(ownerId, id);
  if (!found) throw new AppError("NOT_FOUND", "引用对象不存在", 404);
}

function getOwned(ownerId: string, id: string) {
  return sqlite.prepare(`SELECT ${fields} FROM transactions t
    LEFT JOIN categories c ON c.owner_id=t.owner_id AND c.id=t.category_id
    LEFT JOIN accounts a ON a.owner_id=t.owner_id AND a.id=t.account_id
    LEFT JOIN channels ch ON ch.owner_id=t.owner_id AND ch.id=t.channel_id
    WHERE t.owner_id=? AND t.id=?`).get(ownerId, id) as Row | undefined;
}

function getFx(transactionId: string) {
  return sqlite.prepare(`SELECT base_currency,rate,base_amount_minor,rate_date,rate_source,rate_kind
    FROM transaction_fx WHERE transaction_id=?`).get(transactionId) as FxRow | undefined;
}

function auditState(transaction: Row | undefined, fx: FxRow | undefined) {
  return { transaction: serialize(transaction), fx: serialize(fx as unknown as Row | undefined) ?? null };
}

function ownerBaseCurrency(ownerId: string) {
  const profile = sqlite.prepare("SELECT base_currency FROM profiles WHERE id=?").get(ownerId) as { base_currency: string } | undefined;
  if (!profile) throw new AppError("NOT_FOUND", "用户资料不存在", 404);
  return profile.base_currency.toUpperCase();
}

function validatedFx(ownerId: string, currency: string, amountMinor: bigint, input: FxInput) {
  const baseCurrency = ownerBaseCurrency(ownerId);
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

function upsertFx(transactionId: string, fx: ReturnType<typeof validatedFx>) {
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
}

export function createTransaction(actor: ActorContext, raw: unknown) {
  requirePermission(actor, "transactions:create");
  const parsed = createTransactionSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "账目字段不完整或格式不正确", 422, parsed.error.flatten());
  const input = parsed.data;
  const requestHash = hash(input);
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
      (id,owner_id,kind,amount_minor,currency,occurred_at,occurred_timezone,time_precision,category_id,payment_method,account_id,channel_id,
       merchant,note,related_transaction_id,transfer_group_id,transfer_direction,source,agent_id,idempotency_key,request_hash,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, actor.ownerId, input.kind, BigInt(input.amount_minor), input.currency, input.occurred_at, input.occurred_timezone,
      input.time_precision, categoryId ?? null, input.payment_method ?? null, input.account_id ?? null, input.channel_id ?? null,
      input.merchant ?? null, input.note ?? null, input.related_transaction_id ?? null, input.transfer_group_id ?? null, input.transfer_direction ?? null,
      input.source, actor.actorType === "agent" ? actor.actorId : null, input.idempotency_key, requestHash, 1, timestamp, timestamp,
    );
    if (input.fx) {
      upsertFx(id, validatedFx(actor.ownerId, input.currency, BigInt(input.amount_minor), input.fx));
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
          WHERE t.owner_id=? AND t.transfer_group_id=? ORDER BY t.transfer_direction DESC`).all(actor.ownerId,transaction.transfer_group_id) as Row[];
        return {transaction,pair:pair.map((row)=>serialize(row)!),deduplicated:true};
      }
      throw new AppError("IDEMPOTENCY_CONFLICT","同一幂等键已用于不同内容",409);
    }
    throw error;
  }
  return response;
}

function validateRefund(ownerId: string, input: CreateTransactionInput) {
  const original = sqlite.prepare("SELECT kind, amount_minor, currency, category_id, deleted_at FROM transactions WHERE owner_id=? AND id=?").get(ownerId, input.related_transaction_id) as { kind: string; amount_minor: bigint; currency: string; category_id:string|null; deleted_at: string | null } | undefined;
  if (!original || original.deleted_at) throw new AppError("NOT_FOUND", "原消费不存在", 404);
  if (original.kind !== "expense" || original.currency !== input.currency) throw new AppError("CONFLICT", "退款必须关联同币种消费", 409);
  const refunded = sqlite.prepare("SELECT COALESCE(SUM(amount_minor),0) total FROM transactions WHERE owner_id=? AND related_transaction_id=? AND kind='refund' AND deleted_at IS NULL").get(ownerId, input.related_transaction_id) as { total: bigint };
  if (refunded.total + BigInt(input.amount_minor) > original.amount_minor) throw new AppError("CONFLICT", "退款总额不能超过原消费", 409);
  return original;
}

export function getTransaction(actor: ActorContext, id: string) {
  requirePermission(actor, "transactions:read");
  const row = getOwned(actor.ownerId, id);
  if (!row || row.deleted_at) throw new AppError("NOT_FOUND", "账目不存在", 404);
  return serialize(row);
}

export function listTransactions(actor: ActorContext, raw: unknown) {
  requirePermission(actor, "transactions:read");
  const parsed = transactionFiltersSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "筛选参数不正确", 422, parsed.error.flatten());
  const filters = parsed.data;
  const clauses = ["t.owner_id=?", "t.deleted_at IS NULL"];
  const values: unknown[] = [actor.ownerId];
  const start = filters.start ?? filters.date_from;
  const end = filters.end ?? filters.date_to;
  for (const [column, value] of [["occurred_at >=", start], ["occurred_at <", end], ["kind =", filters.kind], ["currency =", filters.currency], ["category_id =", filters.category_id], ["payment_method =", filters.payment_method], ["account_id =", filters.account_id], ["channel_id =", filters.channel_id]] as const) {
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
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const before = getOwned(actor.ownerId, id);
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
    const beforeFx = getFx(id);
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
      upsertFx(id, validatedFx(actor.ownerId, String(merged.currency), BigInt(String(merged.amount_minor)), parsed.data.fx));
    } else if (beforeFx && (amountChanged || currencyChanged || occurredAtChanged)) {
      const baseCurrency = ownerBaseCurrency(actor.ownerId);
      if (String(merged.currency) === baseCurrency || currencyChanged || occurredAtChanged || beforeFx.base_currency !== baseCurrency) {
        sqlite.prepare("DELETE FROM transaction_fx WHERE transaction_id=?").run(id);
      } else {
        const baseAmountMinor = convertHalfUp(BigInt(String(merged.amount_minor)), beforeFx.rate);
        if (baseAmountMinor <= 0n || baseAmountMinor > maximumMinorAmount) throw new AppError("VALIDATION_ERROR", "折算后的金额超出允许范围", 422);
        sqlite.prepare("UPDATE transaction_fx SET base_amount_minor=? WHERE transaction_id=?").run(baseAmountMinor, id);
      }
    }
    const after = serialize(getOwned(actor.ownerId, id));
    sqlite.prepare(`INSERT INTO audit_events (id,owner_id,actor_type,actor_id,operation,transaction_id,before_json,after_json,request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), actor.ownerId, actor.actorType, actor.actorId, "transaction.update", id, JSON.stringify(auditState(before, beforeFx)), JSON.stringify(auditState(getOwned(actor.ownerId, id), getFx(id))), actor.requestId, now());
    sqlite.exec("COMMIT");
    return after;
  } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}

export function deleteTransaction(actor: ActorContext, id: string, version: number) {
  if (actor.actorType !== "user") throw new AppError("FORBIDDEN", "Agent 不能撤销账目", 403);
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
