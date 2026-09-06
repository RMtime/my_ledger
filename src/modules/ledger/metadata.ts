import { randomUUID } from "node:crypto";
import { sqlite } from "@/db/client";
import { AppError } from "@/modules/shared/errors";
import type { ActorContext } from "@/modules/identity/types";
import { readEncryptedEntity, requireVaultKey, upsertEncryptedEntity, vaultInitialized } from "@/modules/vault/entities";
import { blindIndex } from "@/modules/vault/crypto";

export type MetadataType = "account" | "category" | "channel" | "payment_method";
const tables = { account: "accounts", category: "categories", channel: "channels", payment_method: "payment_methods" } as const;
const pluralTypes = { accounts: "account", categories: "category", channels: "channel", "payment-methods": "payment_method" } as const;
type MetadataValue = { id: string; name: string; sort_order: number; archived_at: string | null; parent_id?: string | null; transaction_kind?: string; type?: string; currency?: string; legacy_code?: string | null };
export function parseMetadataType(value: string): MetadataType | undefined { return (pluralTypes as Record<string, MetadataType>)[value] ?? (Object.hasOwn(tables, value) ? value as MetadataType : undefined); }
function usesVault(actor: ActorContext) { const initialized = vaultInitialized(actor.ownerId); if (initialized) requireVaultKey(actor); return initialized; }
function materialize(actor: ActorContext, type: MetadataType, row: Record<string, unknown>) { if (!usesVault(actor)) return row; const value = readEncryptedEntity<Record<string, unknown>>(actor, type, String(row.id)); if (!value) throw new AppError("CONFLICT", "加密元数据缺失，请运行数据审计", 409); return { ...row, ...value }; }
function listRows(actor: ActorContext, type: MetadataType, includeArchived = false) { const where = includeArchived ? "owner_id=?" : "owner_id=? AND archived_at IS NULL"; return (sqlite.prepare(`SELECT * FROM ${tables[type]} WHERE ${where} ORDER BY sort_order,name,id`).all(actor.ownerId) as Array<Record<string, unknown>>).map((row) => materialize(actor, type, row)); }

export function listMetadata(actor: ActorContext, includeArchived = false) {
  if (!actor.permissions.includes("metadata:read")) throw new AppError("FORBIDDEN", "当前凭证不能读取元数据", 403);
  return {
    categories: listRows(actor, "category", includeArchived).map(({ id, name, parent_id, transaction_kind, sort_order, archived_at }) => ({ id, name, parent_id, transaction_kind, sort_order, archived_at })),
    accounts: listRows(actor, "account", includeArchived).map(({ id, name, type, currency, sort_order, archived_at }) => ({ id, name, type, currency, sort_order, archived_at })),
    channels: listRows(actor, "channel", includeArchived).map(({ id, name, sort_order, archived_at }) => ({ id, name, sort_order, archived_at })),
    payment_methods: listRows(actor, "payment_method", includeArchived).map(({ id, name, legacy_code, sort_order, archived_at }) => ({ id, name, legacy_code, sort_order, archived_at })),
  };
}

function validatedName(input: Record<string, unknown>) { const name = String(input.name ?? "").trim(); if (!name || name.length > 80) throw new AppError("VALIDATION_ERROR", "名称不能为空且不超过 80 字", 422); return name; }
function nextSortOrder(ownerId: string, table: string) { return Number((sqlite.prepare(`SELECT COALESCE(MAX(sort_order),-1)+1 next FROM ${table} WHERE owner_id=?`).get(ownerId) as { next: number }).next); }
function assertUniqueName(actor: ActorContext, type: MetadataType, name: string, excludeId?: string) {
  if (vaultInitialized(actor.ownerId)) {
    const index = blindIndex(requireVaultKey(actor).key, actor.ownerId, `${type}:name`, name);
    const duplicate = sqlite.prepare("SELECT entity_id FROM encrypted_entities WHERE owner_id=? AND entity_type=? AND blind_name=? AND entity_id<>?").get(actor.ownerId, type, index, excludeId ?? "") as { entity_id: string } | undefined;
    if (duplicate) throw new AppError("CONFLICT", "同名条目已经存在", 409);
  }
}

export function createMetadata(actor: ActorContext, type: MetadataType, input: Record<string, unknown>) {
  if (actor.actorType !== "user") throw new AppError("FORBIDDEN", "Agent 不能修改元数据", 403);
  const secure = usesVault(actor); const id = randomUUID(); const now = new Date().toISOString(); const name = validatedName(input); assertUniqueName(actor, type, name); const sortOrder = nextSortOrder(actor.ownerId, tables[type]);
  if (type === "account") { const value = { id, name, type: String(input.type ?? "other"), currency: String(input.currency ?? "HKD").toUpperCase(), sort_order: sortOrder, archived_at: null }; sqlite.prepare("INSERT INTO accounts (id,owner_id,name,type,currency,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, actor.ownerId, secure ? `enc:${id}` : name, secure ? "other" : value.type, secure ? "XXX" : value.currency, sortOrder, now, now); if (secure) upsertEncryptedEntity(actor, "account", id, value, { name }); }
  if (type === "category") { const parentId = input.parent_id ? String(input.parent_id) : null; const kind = String(input.transaction_kind ?? "expense"); if (!["expense", "income", "refund"].includes(kind)) throw new AppError("VALIDATION_ERROR", "分类类型不正确", 422); if (parentId) { const parent = listRows(actor, "category", true).find((row) => row.id === parentId); if (!parent || parent.archived_at) throw new AppError("NOT_FOUND", "父分类不存在", 404); if (parent.parent_id) throw new AppError("VALIDATION_ERROR", "分类最多两级", 422); if (parent.transaction_kind !== kind) throw new AppError("VALIDATION_ERROR", "父子分类必须属于同一收支类型", 422); } const value = { id, name, parent_id: parentId, transaction_kind: kind, sort_order: sortOrder, archived_at: null }; sqlite.prepare("INSERT INTO categories (id,owner_id,name,parent_id,transaction_kind,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, actor.ownerId, secure ? `enc:${id}` : name, parentId, secure ? "expense" : kind, sortOrder, now, now); if (secure) upsertEncryptedEntity(actor, "category", id, value, { name, kind }); }
  if (type === "channel") { const value = { id, name, sort_order: sortOrder, archived_at: null }; sqlite.prepare("INSERT INTO channels (id,owner_id,name,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, actor.ownerId, secure ? `enc:${id}` : name, sortOrder, now, now); if (secure) upsertEncryptedEntity(actor, "channel", id, value, { name }); }
  if (type === "payment_method") { const value = { id, name, legacy_code: null, sort_order: sortOrder, archived_at: null }; sqlite.prepare("INSERT INTO payment_methods (id,owner_id,name,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, actor.ownerId, secure ? `enc:${id}` : name, sortOrder, now, now); if (secure) upsertEncryptedEntity(actor, "payment_method", id, value, { name }); }
  return { id, name, sort_order: sortOrder };
}

export function updateMetadata(actor: ActorContext, type: MetadataType, id: string, input: Record<string, unknown>) {
  if (actor.actorType !== "user") throw new AppError("FORBIDDEN", "Agent 不能修改元数据", 403);
  const secure = usesVault(actor); const current = listRows(actor, type, true).find((row) => row.id === id); if (!current) throw new AppError("NOT_FOUND", "元数据不存在", 404);
  const updated = { ...current, ...(input.name === undefined ? {} : { name: validatedName(input) }), ...(input.sort_order === undefined ? {} : { sort_order: Number(input.sort_order) }), ...(input.archived === undefined ? {} : { archived_at: input.archived ? new Date().toISOString() : null }) } as unknown as MetadataValue;
  if (input.name !== undefined) assertUniqueName(actor, type, String(updated.name), id);
  if (!Number.isInteger(updated.sort_order) || Number(updated.sort_order) < 0 || Number(updated.sort_order) > 100000) throw new AppError("VALIDATION_ERROR", "排序值不正确", 422);
  if (type === "category") { const kind = input.transaction_kind === undefined ? String(updated.transaction_kind) : String(input.transaction_kind); const parentId = input.parent_id === undefined ? updated.parent_id : input.parent_id ? String(input.parent_id) : null; if (!["expense", "income", "refund"].includes(kind)) throw new AppError("VALIDATION_ERROR", "分类类型不正确", 422); if (parentId === id) throw new AppError("VALIDATION_ERROR", "分类不能以自身为父级", 422); if (parentId) { const parent = listRows(actor, "category", true).find((row) => row.id === parentId); if (!parent || parent.archived_at || parent.parent_id || parent.transaction_kind !== kind) throw new AppError("VALIDATION_ERROR", "父分类必须有效、同类型且位于顶层", 422); } Object.assign(updated, { parent_id: parentId, transaction_kind: kind }); const children = listRows(actor, "category", true).filter((row) => row.parent_id === id); if (children.some((child) => child.transaction_kind !== kind)) throw new AppError("CONFLICT", "请先调整子分类的收支类型", 409); }
  sqlite.prepare(`UPDATE ${tables[type]} SET sort_order=?,archived_at=?,updated_at=? WHERE owner_id=? AND id=?`).run(updated.sort_order, updated.archived_at, new Date().toISOString(), actor.ownerId, id);
  if (secure) upsertEncryptedEntity(actor, type, id, updated, { name: String(updated.name), kind: type === "category" ? String(updated.transaction_kind) : undefined });
  else { if (type === "account") sqlite.prepare("UPDATE accounts SET name=?,type=?,currency=? WHERE owner_id=? AND id=?").run(updated.name, updated.type, updated.currency, actor.ownerId, id); if (type === "category") sqlite.prepare("UPDATE categories SET name=?,parent_id=?,transaction_kind=? WHERE owner_id=? AND id=?").run(updated.name, updated.parent_id, updated.transaction_kind, actor.ownerId, id); if (type === "channel") sqlite.prepare("UPDATE channels SET name=? WHERE owner_id=? AND id=?").run(updated.name, actor.ownerId, id); if (type === "payment_method") sqlite.prepare("UPDATE payment_methods SET name=? WHERE owner_id=? AND id=?").run(updated.name, actor.ownerId, id); }
  return { id, name: updated.name, sort_order: updated.sort_order, archived_at: updated.archived_at };
}
