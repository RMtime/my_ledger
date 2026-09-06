import { randomBytes, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { sqlite } from "@/db/client";
import type { ActorContext } from "@/modules/identity/types";
import { AppError } from "@/modules/shared/errors";
import { blindIndex, derivePassphraseKey, deriveRecoveryKey, unwrapMasterKey, vaultKdf, wrapMasterKey, type CipherEnvelope } from "./crypto";
import { readEncryptedEntity, upsertEncryptedEntity } from "./entities";
import { createVaultSession, revokeOwnerVaultSessions } from "./session";
import { parseDecimal } from "@/modules/fx/rational";
import { revokeOwnerAgentVaultGrants } from "./agent-session";

const starterPayments = [
  ["cash", "现金"], ["card", "刷卡"], ["apple_pay", "Apple Pay"], ["alipay", "支付宝"],
  ["wechat_pay", "微信支付"], ["bank_transfer", "银行转账"], ["other", "其他"],
] as const;
const starterCategories = [["餐饮", "expense"], ["住房", "expense"], ["交通", "expense"], ["工资", "income"], ["退款", "refund"]] as const;
const starterAccounts = [["现金钱包", "wallet", "HKD"], ["主要银行卡", "bank", "HKD"]] as const;
const starterChannels = ["线下", "网上商城"] as const;

type VaultRow = { owner_id: string; key_version: number; kdf_salt: string; kdf_n: number; kdf_r: number; kdf_p: number; passphrase_envelope: string; recovery_envelope: string };
const parseEnvelope = (value: string) => JSON.parse(value) as CipherEnvelope;
const validatePassphrase = (value: unknown) => { const passphrase = String(value ?? ""); if (passphrase.length < 12 || passphrase.length > 128) throw new AppError("VALIDATION_ERROR", "保险库口令必须为 12–128 个字符", 422); return passphrase; };
const jsonSafe = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]));

function getVault(ownerId: string) {
  return sqlite.prepare("SELECT * FROM user_vaults WHERE owner_id=?").get(ownerId) as VaultRow | undefined;
}

export function getVaultStatus(ownerId: string) {
  const vault = getVault(ownerId);
  return vault ? { initialized: true, key_version: Number(vault.key_version) } : { initialized: false, key_version: null };
}

function createStarterPaymentMethods(actor: ActorContext) {
  const now = new Date().toISOString(); const ids = new Map<string, string>();
  for (const [index, [legacyCode, name]] of starterPayments.entries()) {
    const existing = sqlite.prepare("SELECT id FROM payment_methods WHERE owner_id=? AND legacy_code=?").get(actor.ownerId, legacyCode) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID(); ids.set(legacyCode, id);
    if (!existing) sqlite.prepare("INSERT INTO payment_methods (id,owner_id,name,legacy_code,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, actor.ownerId, name, legacyCode, index, now, now);
    upsertEncryptedEntity(actor, "payment_method", id, { name, legacy_code: legacyCode, sort_order: index }, { name });
    sqlite.prepare("UPDATE payment_methods SET name=? WHERE owner_id=? AND id=?").run(`enc:${id}`, actor.ownerId, id);
  }
  return ids;
}

function createStarterMetadata(actor: ActorContext) {
  const now = new Date().toISOString();
  if (!(sqlite.prepare("SELECT 1 FROM categories WHERE owner_id=? LIMIT 1").get(actor.ownerId))) {
    starterCategories.forEach(([name, transactionKind], sortOrder) => {
      const id = randomUUID();
      sqlite.prepare("INSERT INTO categories (id,owner_id,name,parent_id,transaction_kind,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, actor.ownerId, `enc:${id}`, null, "expense", sortOrder, now, now);
      upsertEncryptedEntity(actor, "category", id, { id, name, parent_id: null, transaction_kind: transactionKind, sort_order: sortOrder, archived_at: null }, { name, kind: transactionKind });
    });
  }
  if (!(sqlite.prepare("SELECT 1 FROM accounts WHERE owner_id=? LIMIT 1").get(actor.ownerId))) {
    starterAccounts.forEach(([name, type, currency], sortOrder) => {
      const id = randomUUID();
      sqlite.prepare("INSERT INTO accounts (id,owner_id,name,type,currency,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, actor.ownerId, `enc:${id}`, "other", "XXX", sortOrder, now, now);
      upsertEncryptedEntity(actor, "account", id, { id, name, type, currency, sort_order: sortOrder, archived_at: null }, { name });
    });
  }
  if (!(sqlite.prepare("SELECT 1 FROM channels WHERE owner_id=? LIMIT 1").get(actor.ownerId))) {
    starterChannels.forEach((name, sortOrder) => {
      const id = randomUUID();
      sqlite.prepare("INSERT INTO channels (id,owner_id,name,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, actor.ownerId, `enc:${id}`, sortOrder, now, now);
      upsertEncryptedEntity(actor, "channel", id, { id, name, sort_order: sortOrder, archived_at: null }, { name });
    });
  }
}

function backfillPrivateData(actor: ActorContext) {
  const profile = sqlite.prepare("SELECT timezone,base_currency FROM profiles WHERE id=?").get(actor.ownerId) as { timezone: string; base_currency: string };
  const paymentIds = createStarterPaymentMethods(actor);
  for (const row of sqlite.prepare("SELECT * FROM accounts WHERE owner_id=?").all(actor.ownerId) as Array<Record<string, unknown>>) {
    const value = jsonSafe(row); upsertEncryptedEntity(actor, "account", String(row.id), value, { name: String(row.name) });
    sqlite.prepare("UPDATE accounts SET name=?,type='other',currency='XXX' WHERE owner_id=? AND id=?").run(`enc:${row.id}`, actor.ownerId, row.id);
  }
  for (const row of sqlite.prepare("SELECT * FROM categories WHERE owner_id=?").all(actor.ownerId) as Array<Record<string, unknown>>) {
    const value = jsonSafe(row); upsertEncryptedEntity(actor, "category", String(row.id), value, { name: String(row.name), kind: String(row.transaction_kind) });
    sqlite.prepare("UPDATE categories SET name=?,transaction_kind='expense' WHERE owner_id=? AND id=?").run(`enc:${row.id}`, actor.ownerId, row.id);
  }
  for (const row of sqlite.prepare("SELECT * FROM channels WHERE owner_id=?").all(actor.ownerId) as Array<Record<string, unknown>>) {
    const value = jsonSafe(row); upsertEncryptedEntity(actor, "channel", String(row.id), value, { name: String(row.name) });
    sqlite.prepare("UPDATE channels SET name=? WHERE owner_id=? AND id=?").run(`enc:${row.id}`, actor.ownerId, row.id);
  }
  createStarterMetadata(actor);
  for (const row of sqlite.prepare("SELECT * FROM transactions WHERE owner_id=?").all(actor.ownerId) as Array<Record<string, unknown>>) {
    const paymentMethodId = row.payment_method ? paymentIds.get(String(row.payment_method)) ?? null : null;
    const value = { ...jsonSafe(row), payment_method_id: paymentMethodId }; const id = String(row.id); const occurredAt = String(row.occurred_at); const month = DateTime.fromISO(occurredAt).setZone(profile.timezone).toFormat("yyyy-MM");
    upsertEncryptedEntity(actor, "transaction", id, value, { month, kind: String(row.kind), currency: String(row.currency), idempotency: String(row.idempotency_key) });
    sqlite.prepare(`UPDATE transactions SET kind='expense',amount_minor=1,currency='XXX',occurred_at='1970-01-01T00:00:00.000Z',occurred_timezone='UTC',time_precision='date',payment_method=NULL,payment_method_id=?,merchant=NULL,note=NULL,idempotency_key=?,request_hash=? WHERE owner_id=? AND id=?`).run(
      paymentMethodId, `enc:${id}`, blindIndex(actor.vaultKey!, actor.ownerId, "transaction:request", String(row.request_hash)), actor.ownerId, id,
    );
  }
  for (const row of sqlite.prepare("SELECT fx.* FROM transaction_fx fx JOIN transactions t ON t.id=fx.transaction_id WHERE t.owner_id=?").all(actor.ownerId) as Array<Record<string, unknown>>) {
    const id = String(row.transaction_id); const value = jsonSafe(row); upsertEncryptedEntity(actor, "transaction_fx", id, value);
    const rate = parseDecimal(String(row.rate)); const target = String(row.base_currency);
    upsertEncryptedEntity(actor, "fx_snapshot", `${id}:${target}`, { transaction_id: id, target_currency: target, source_date: row.rate_date, source: row.rate_source, rate_numerator: rate.numerator.toString(), rate_denominator: rate.denominator.toString(), base_amount_minor: String(row.base_amount_minor), status: "available" });
    const timestamp = new Date().toISOString();
    sqlite.prepare("INSERT INTO fx_snapshots (transaction_id,target_currency,source_date,source,rate,base_amount_minor,status,created_at,updated_at) VALUES (?,?,NULL,'encrypted',NULL,NULL,'available',?,?) ON CONFLICT(transaction_id,target_currency) DO UPDATE SET source_date=NULL,source='encrypted',rate=NULL,base_amount_minor=NULL,status='available',updated_at=excluded.updated_at").run(id, target, timestamp, timestamp);
    sqlite.prepare("UPDATE transaction_fx SET base_currency='XXX',rate='1',base_amount_minor=1,rate_date='1970-01-01',rate_source='encrypted',rate_kind='manual' WHERE transaction_id=?").run(id);
  }
  for (const row of sqlite.prepare("SELECT * FROM audit_events WHERE owner_id=?").all(actor.ownerId) as Array<Record<string, unknown>>) {
    const id = String(row.id); upsertEncryptedEntity(actor, "audit_event", id, jsonSafe(row));
    sqlite.prepare("UPDATE audit_events SET operation='encrypted',before_json=NULL,after_json=NULL,request_id=? WHERE owner_id=? AND id=?").run(`enc:${id}`, actor.ownerId, id);
  }
  for (const row of sqlite.prepare("SELECT * FROM ai_reports WHERE owner_id=?").all(actor.ownerId) as Array<Record<string, unknown>>) {
    const id = String(row.id); upsertEncryptedEntity(actor, "ai_report", id, jsonSafe(row));
    sqlite.prepare("UPDATE ai_reports SET period=?,filters_json='{}',snapshot_json='{}',snapshot_hash=?,model='encrypted',prompt_version='encrypted',report_json='{}' WHERE owner_id=? AND id=?").run(`enc:${id}`, `enc:${id}`, actor.ownerId, id);
  }
  upsertEncryptedEntity(actor, "profile", actor.ownerId, profile);
  upsertEncryptedEntity(actor, "ai_preferences", actor.ownerId, { enabled: false, provider: null, consent_version: null });
  sqlite.prepare("INSERT INTO ai_preferences (owner_id,provider,enabled,consent_version,created_at,updated_at) VALUES (?,NULL,0,NULL,?,?) ON CONFLICT(owner_id) DO UPDATE SET provider=NULL,enabled=0,consent_version=NULL,updated_at=excluded.updated_at").run(actor.ownerId, new Date().toISOString(), new Date().toISOString());
  sqlite.prepare("UPDATE profiles SET timezone='UTC',base_currency='HKD',updated_at=? WHERE id=?").run(new Date().toISOString(), actor.ownerId);
}

function assertEncryptedBackfill(actor: ActorContext) {
  const mappings = [
    ["transactions", "transaction"], ["accounts", "account"], ["categories", "category"], ["channels", "channel"],
    ["payment_methods", "payment_method"], ["audit_events", "audit_event"], ["ai_reports", "ai_report"],
  ] as const;
  for (const [table, entityType] of mappings) {
    const source = Number((sqlite.prepare(`SELECT COUNT(*) count FROM ${table} WHERE owner_id=?`).get(actor.ownerId) as { count: number }).count);
    const encrypted = Number((sqlite.prepare("SELECT COUNT(*) count FROM encrypted_entities WHERE owner_id=? AND entity_type=?").get(actor.ownerId, entityType) as { count: number }).count);
    if (source !== encrypted) throw new AppError("MIGRATION_NOT_READY", `${table} 加密回填数量不一致`, 409);
  }
  const transactionRows = sqlite.prepare("SELECT id,kind,amount_minor,currency,occurred_at,merchant,note,idempotency_key FROM transactions WHERE owner_id=?").all(actor.ownerId) as Array<Record<string, unknown>>;
  for (const row of transactionRows) {
    if (row.kind !== "expense" || BigInt(String(row.amount_minor)) !== 1n || row.currency !== "XXX" || row.occurred_at !== "1970-01-01T00:00:00.000Z" || row.merchant !== null || row.note !== null || row.idempotency_key !== `enc:${row.id}`) {
      throw new AppError("MIGRATION_NOT_READY", "账目明文字段尚未完全隔离", 409);
    }
    if (!readEncryptedEntity(actor, "transaction", String(row.id))) throw new AppError("MIGRATION_NOT_READY", "账目密文无法校验", 409);
  }
  const fxLeak = sqlite.prepare("SELECT 1 FROM fx_snapshots fs JOIN transactions t ON t.id=fs.transaction_id WHERE t.owner_id=? AND (fs.rate IS NOT NULL OR fs.base_amount_minor IS NOT NULL OR fs.source_date IS NOT NULL) LIMIT 1").get(actor.ownerId);
  if (fxLeak) throw new AppError("MIGRATION_NOT_READY", "汇率快照仍包含明文字段", 409);
  if (!readEncryptedEntity(actor, "profile", actor.ownerId)) throw new AppError("MIGRATION_NOT_READY", "用户偏好密文缺失", 409);
}

export async function initializeVault(actor: ActorContext, rawPassphrase: unknown) {
  if (getVault(actor.ownerId)) throw new AppError("CONFLICT", "保险库已经初始化", 409);
  const passphrase = validatePassphrase(rawPassphrase); const masterKey = randomBytes(32); const recoveryBytes = randomBytes(32); const recoveryKey = recoveryBytes.toString("base64url"); const salt = randomBytes(16); const keyVersion = 1;
  const passphraseKey = await derivePassphraseKey(passphrase, salt); const recoveryKek = deriveRecoveryKey(recoveryBytes, actor.ownerId); const now = new Date().toISOString();
  const unlockedActor = { ...actor, vaultKey: masterKey, vaultKeyVersion: keyVersion };
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.prepare(`INSERT INTO user_vaults (owner_id,key_version,kdf_salt,kdf_n,kdf_r,kdf_p,passphrase_envelope,recovery_envelope,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      actor.ownerId, keyVersion, salt.toString("base64url"), vaultKdf.N, vaultKdf.r, vaultKdf.p,
      JSON.stringify(wrapMasterKey(passphraseKey, masterKey, actor.ownerId, keyVersion, "passphrase")), JSON.stringify(wrapMasterKey(recoveryKek, masterKey, actor.ownerId, keyVersion, "recovery")), now, now,
    );
    backfillPrivateData(unlockedActor); assertEncryptedBackfill(unlockedActor); sqlite.exec("COMMIT");
  } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  finally { passphraseKey.fill(0); recoveryKek.fill(0); recoveryBytes.fill(0); }
  const token = createVaultSession(actor.ownerId, masterKey, keyVersion); masterKey.fill(0);
  return { token, recovery_key: recoveryKey, key_version: keyVersion };
}

export async function unlockVault(actor: ActorContext, rawPassphrase: unknown) {
  const passphrase = validatePassphrase(rawPassphrase); const vault = getVault(actor.ownerId); if (!vault) throw new AppError("CONFLICT", "保险库尚未初始化", 409);
  const salt = Buffer.from(vault.kdf_salt, "base64url"); const key = await derivePassphraseKey(passphrase, salt, { N: Number(vault.kdf_n), r: Number(vault.kdf_r), p: Number(vault.kdf_p), maxmem: vaultKdf.maxmem });
  try { const master = unwrapMasterKey(key, parseEnvelope(vault.passphrase_envelope), actor.ownerId, Number(vault.key_version), "passphrase"); const token = createVaultSession(actor.ownerId, master, Number(vault.key_version)); master.fill(0); return { token, key_version: Number(vault.key_version) }; }
  catch { throw new AppError("AUTH_REQUIRED", "保险库口令不正确", 401); }
  finally { key.fill(0); }
}

export async function recoverVault(actor: ActorContext, rawRecoveryKey: unknown, rawNewPassphrase: unknown) {
  const newPassphrase = validatePassphrase(rawNewPassphrase); const vault = getVault(actor.ownerId); if (!vault) throw new AppError("CONFLICT", "保险库尚未初始化", 409);
  const recoveryBytes = Buffer.from(String(rawRecoveryKey ?? ""), "base64url"); if (recoveryBytes.length !== 32) throw new AppError("AUTH_REQUIRED", "恢复密钥不正确", 401);
  const recoveryKek = deriveRecoveryKey(recoveryBytes, actor.ownerId); let master: Buffer;
  try { master = unwrapMasterKey(recoveryKek, parseEnvelope(vault.recovery_envelope), actor.ownerId, Number(vault.key_version), "recovery"); }
  catch { throw new AppError("AUTH_REQUIRED", "恢复密钥不正确", 401); }
  finally { recoveryBytes.fill(0); recoveryKek.fill(0); }
  const salt = randomBytes(16); const passphraseKey = await derivePassphraseKey(newPassphrase, salt);
  try { sqlite.prepare("UPDATE user_vaults SET kdf_salt=?,kdf_n=?,kdf_r=?,kdf_p=?,passphrase_envelope=?,updated_at=? WHERE owner_id=?").run(salt.toString("base64url"), vaultKdf.N, vaultKdf.r, vaultKdf.p, JSON.stringify(wrapMasterKey(passphraseKey, master, actor.ownerId, Number(vault.key_version), "passphrase")), new Date().toISOString(), actor.ownerId); revokeOwnerVaultSessions(actor.ownerId); const token = createVaultSession(actor.ownerId, master, Number(vault.key_version)); return { token, key_version: Number(vault.key_version) }; }
  finally { passphraseKey.fill(0); master.fill(0); }
}

export async function rotateVaultPassphrase(actor: ActorContext, rawNewPassphrase: unknown) {
  const newPassphrase = validatePassphrase(rawNewPassphrase); if (!actor.vaultKey || !actor.vaultKeyVersion) throw new AppError("VAULT_LOCKED", "保险库已锁定，请先解锁", 423);
  const salt = randomBytes(16); const key = await derivePassphraseKey(newPassphrase, salt); const master = Buffer.from(actor.vaultKey);
  try {
    sqlite.prepare("UPDATE user_vaults SET kdf_salt=?,kdf_n=?,kdf_r=?,kdf_p=?,passphrase_envelope=?,updated_at=? WHERE owner_id=?").run(salt.toString("base64url"), vaultKdf.N, vaultKdf.r, vaultKdf.p, JSON.stringify(wrapMasterKey(key, master, actor.ownerId, actor.vaultKeyVersion, "passphrase")), new Date().toISOString(), actor.ownerId);
    revokeOwnerVaultSessions(actor.ownerId); revokeOwnerAgentVaultGrants(actor.ownerId);
    return { token: createVaultSession(actor.ownerId, master, actor.vaultKeyVersion), key_version: actor.vaultKeyVersion };
  } finally { key.fill(0); master.fill(0); }
}
