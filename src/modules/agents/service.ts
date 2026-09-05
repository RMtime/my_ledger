import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { sqlite } from "@/db/client";
import { AppError } from "@/modules/shared/errors";
import { permissions, type ActorContext, type Permission } from "@/modules/identity/types";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function issueCredential(actor: ActorContext, input: { agent_name: string; permissions: Permission[]; expires_at?: string | null }) {
  if (actor.actorType !== "user") throw new AppError("FORBIDDEN", "Agent 不能管理凭证", 403);
  if (!input.agent_name?.trim() || !input.permissions?.length || input.permissions.some((p) => !permissions.includes(p))) throw new AppError("VALIDATION_ERROR", "Agent 名称或权限不正确", 422);
  const secret = `plg_${randomBytes(32).toString("base64url")}`;
  const id = randomUUID(); const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO agent_credentials (id,owner_id,agent_name,token_prefix,token_hash,permissions,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, actor.ownerId, input.agent_name.trim(), secret.slice(0, 12), digest(secret).toString("hex"), JSON.stringify(input.permissions), input.expires_at ?? null, now, now);
  return { id, token: secret, token_prefix: secret.slice(0, 12), warning: "此 token 只显示一次，请立即保存" };
}

export function listCredentials(actor: ActorContext) {
  return sqlite.prepare("SELECT id,agent_name,token_prefix,permissions,expires_at,revoked_at,last_used_at,created_at FROM agent_credentials WHERE owner_id=? ORDER BY created_at DESC").all(actor.ownerId);
}

export function revokeCredential(actor: ActorContext, id: string) {
  const result = sqlite.prepare("UPDATE agent_credentials SET revoked_at=?,updated_at=? WHERE owner_id=? AND id=? AND revoked_at IS NULL").run(new Date().toISOString(), new Date().toISOString(), actor.ownerId, id);
  if (!result.changes) throw new AppError("NOT_FOUND", "凭证不存在", 404);
}

export function authenticatePat(authorization: string | null, requestId: string): ActorContext {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token?.startsWith("plg_") || token.length < 40) throw new AppError("UNAUTHENTICATED", "需要有效的 Bearer PAT", 401);
  const candidate = digest(token);
  const rows = sqlite.prepare("SELECT id,owner_id,token_hash,permissions,expires_at,revoked_at FROM agent_credentials WHERE token_prefix=?").all(token.slice(0, 12)) as Array<{ id: string; owner_id: string; token_hash: string; permissions: string; expires_at: string | null; revoked_at: string | null }>;
  const credential = rows.find((row) => { const saved = Buffer.from(row.token_hash, "hex"); return saved.length === candidate.length && timingSafeEqual(saved, candidate); });
  if (!credential || credential.revoked_at || (credential.expires_at && Date.parse(credential.expires_at) <= Date.now())) throw new AppError("UNAUTHENTICATED", "PAT 无效、已过期或已撤销", 401);
  sqlite.prepare("UPDATE agent_credentials SET last_used_at=? WHERE id=?").run(new Date().toISOString(), credential.id);
  return { ownerId: credential.owner_id, actorType: "agent", actorId: credential.id, permissions: JSON.parse(credential.permissions), requestId };
}
