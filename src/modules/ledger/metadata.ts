import { randomUUID } from "node:crypto";
import { sqlite } from "@/db/client";
import { AppError } from "@/modules/shared/errors";
import type { ActorContext } from "@/modules/identity/types";

export function listMetadata(actor: ActorContext) {
  if (!actor.permissions.includes("metadata:read")) throw new AppError("FORBIDDEN", "当前凭证不能读取元数据", 403);
  return {
    categories: sqlite.prepare("SELECT id,name,parent_id,transaction_kind FROM categories WHERE owner_id=? AND archived_at IS NULL ORDER BY transaction_kind,name").all(actor.ownerId) as Array<{id:string;name:string;parent_id:string|null;transaction_kind:string}>,
    accounts: sqlite.prepare("SELECT id,name,type,currency FROM accounts WHERE owner_id=? AND archived_at IS NULL ORDER BY name").all(actor.ownerId) as Array<{id:string;name:string;type:string;currency:string}>,
    channels: sqlite.prepare("SELECT id,name FROM channels WHERE owner_id=? AND archived_at IS NULL ORDER BY name").all(actor.ownerId) as Array<{id:string;name:string}>,
  };
}

export function createMetadata(actor: ActorContext, type: "account" | "category" | "channel", input: Record<string, unknown>) {
  const id = randomUUID(); const now = new Date().toISOString();
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 80) throw new AppError("VALIDATION_ERROR", "名称不能为空且不超过 80 字", 422);
  if (type === "account") sqlite.prepare("INSERT INTO accounts (id,owner_id,name,type,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, actor.ownerId, name, input.type ?? "other", String(input.currency ?? "HKD").toUpperCase(), now, now);
  if (type === "category") {
    const parentId = input.parent_id ? String(input.parent_id) : null;
    if (parentId) { const parent=sqlite.prepare("SELECT parent_id FROM categories WHERE owner_id=? AND id=? AND archived_at IS NULL").get(actor.ownerId,parentId) as {parent_id:string|null}|undefined; if(!parent)throw new AppError("NOT_FOUND","父分类不存在",404); if(parent.parent_id)throw new AppError("VALIDATION_ERROR","分类最多两级",422); }
    sqlite.prepare("INSERT INTO categories (id,owner_id,name,parent_id,transaction_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, actor.ownerId, name, parentId, input.transaction_kind ?? "expense", now, now);
  }
  if (type === "channel") sqlite.prepare("INSERT INTO channels (id,owner_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, actor.ownerId, name, now, now);
  return { id, name };
}
