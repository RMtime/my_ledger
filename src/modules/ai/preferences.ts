import { sqlite } from "@/db/client";
import type { ActorContext } from "@/modules/identity/types";
import { AppError } from "@/modules/shared/errors";
import { readEncryptedEntity, upsertEncryptedEntity, vaultInitialized } from "@/modules/vault/entities";

export type AiProvider = "deepseek" | "minimax";
const validProviders = new Set<AiProvider>(["deepseek", "minimax"]);
export function getAiPreferences(actor: ActorContext) {
  if (vaultInitialized(actor.ownerId)) return readEncryptedEntity<{ enabled: boolean; provider: AiProvider | null; consent_version: string | null }>(actor, "ai_preferences", actor.ownerId) ?? { enabled: false, provider: null, consent_version: null };
  const row = sqlite.prepare("SELECT enabled,provider,consent_version FROM ai_preferences WHERE owner_id=?").get(actor.ownerId) as { enabled: number; provider: AiProvider | null; consent_version: string | null } | undefined;
  return row ? { enabled: Boolean(row.enabled), provider: row.provider, consent_version: row.consent_version } : { enabled: false, provider: null, consent_version: null };
}
export function updateAiPreferences(actor: ActorContext, input: Record<string, unknown>) {
  const enabled = Boolean(input.enabled); const provider = input.provider === null || input.provider === undefined || input.provider === "" ? null : String(input.provider) as AiProvider; const consent = input.consent_version === undefined ? null : String(input.consent_version);
  if (provider && !validProviders.has(provider)) throw new AppError("VALIDATION_ERROR", "AI provider 不受支持", 422);
  if (enabled && (!provider || !consent)) throw new AppError("VALIDATION_ERROR", "启用 AI 前必须选择厂商并确认披露版本", 422);
  const value = { enabled, provider, consent_version: consent }; const now = new Date().toISOString();
  sqlite.prepare("INSERT INTO ai_preferences (owner_id,provider,enabled,consent_version,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET provider=excluded.provider,enabled=excluded.enabled,consent_version=excluded.consent_version,updated_at=excluded.updated_at").run(actor.ownerId, provider, enabled ? 1 : 0, consent, now, now);
  if (vaultInitialized(actor.ownerId)) { upsertEncryptedEntity(actor, "ai_preferences", actor.ownerId, value); sqlite.prepare("UPDATE ai_preferences SET provider=NULL,enabled=0,consent_version=NULL,updated_at=? WHERE owner_id=?").run(now, actor.ownerId); }
  return value;
}
