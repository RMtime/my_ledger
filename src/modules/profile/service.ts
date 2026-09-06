import { sqlite } from "@/db/client";
import type { ActorContext } from "@/modules/identity/types";
import { AppError } from "@/modules/shared/errors";
import { readEncryptedEntity, upsertEncryptedEntity, vaultInitialized } from "@/modules/vault/entities";

const currencies = new Set(["HKD", "CNY", "USD"]);
function assertTimezone(value: unknown) { const timezone = String(value ?? ""); try { new Intl.DateTimeFormat("en", { timeZone: timezone }); return timezone; } catch { throw new AppError("VALIDATION_ERROR", "无效的 IANA 时区", 422); } }

export function getProfile(actor: ActorContext) {
  if (vaultInitialized(actor.ownerId)) return readEncryptedEntity<Record<string, unknown>>(actor, "profile", actor.ownerId);
  return sqlite.prepare("SELECT timezone,base_currency,email FROM profiles WHERE id=?").get(actor.ownerId) as Record<string, unknown> | undefined;
}

export function updateProfile(actor: ActorContext, input: Record<string, unknown>) {
  const current = getProfile(actor); if (!current) throw new AppError("NOT_FOUND", "用户资料不存在", 404);
  const timezone = input.timezone === undefined ? String(current.timezone) : assertTimezone(input.timezone);
  const baseCurrency = input.base_currency === undefined ? String(current.base_currency).toUpperCase() : String(input.base_currency).toUpperCase();
  if (!currencies.has(baseCurrency)) throw new AppError("VALIDATION_ERROR", "本位币只支持 HKD、CNY、USD", 422);
  const updated = { ...current, timezone, base_currency: baseCurrency };
  const now = new Date().toISOString();
  if (vaultInitialized(actor.ownerId)) { upsertEncryptedEntity(actor, "profile", actor.ownerId, updated); sqlite.prepare("UPDATE profiles SET timezone='UTC',base_currency='HKD',updated_at=? WHERE id=?").run(now, actor.ownerId); }
  else sqlite.prepare("UPDATE profiles SET timezone=?,base_currency=?,updated_at=? WHERE id=?").run(timezone, baseCurrency, now, actor.ownerId);
  return updated;
}
