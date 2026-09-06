import { sqlite } from "@/db/client";
import type { ActorContext } from "@/modules/identity/types";
import { AppError } from "@/modules/shared/errors";
import { blindIndex, decryptEntity, encryptEntity, type CipherEnvelope } from "./crypto";

export type EntityIndexes = { month?: string; kind?: string; currency?: string; name?: string; idempotency?: string };

export function vaultInitialized(ownerId: string) {
  return Boolean(sqlite.prepare("SELECT 1 FROM user_vaults WHERE owner_id=?").get(ownerId));
}

export function requireVaultKey(actor: ActorContext) {
  if (!actor.vaultKey || !actor.vaultKeyVersion) throw new AppError("VAULT_LOCKED", "保险库已锁定，请先解锁", 423);
  return { key: actor.vaultKey, keyVersion: actor.vaultKeyVersion };
}

export function upsertEncryptedEntity(actor: ActorContext, entityType: string, entityId: string, value: unknown, indexes: EntityIndexes = {}) {
  const { key, keyVersion } = requireVaultKey(actor); const encrypted = encryptEntity(key, actor.ownerId, entityType, entityId, keyVersion, value); const now = new Date().toISOString();
  const index = (domain: string, input?: string) => input === undefined ? null : blindIndex(key, actor.ownerId, `${entityType}:${domain}`, input);
  sqlite.prepare(`INSERT INTO encrypted_entities (owner_id,entity_type,entity_id,key_version,nonce,ciphertext,tag,blind_month,blind_kind,blind_currency,blind_name,blind_idempotency,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,entity_type,entity_id) DO UPDATE SET key_version=excluded.key_version,nonce=excluded.nonce,ciphertext=excluded.ciphertext,tag=excluded.tag,blind_month=excluded.blind_month,blind_kind=excluded.blind_kind,blind_currency=excluded.blind_currency,blind_name=excluded.blind_name,blind_idempotency=excluded.blind_idempotency,updated_at=excluded.updated_at`).run(
    actor.ownerId, entityType, entityId, keyVersion, encrypted.nonce, encrypted.ciphertext, encrypted.tag,
    index("month", indexes.month), index("kind", indexes.kind), index("currency", indexes.currency), index("name", indexes.name), index("idempotency", indexes.idempotency), now, now,
  );
}

export function readEncryptedEntity<T>(actor: ActorContext, entityType: string, entityId: string): T | undefined {
  const { key } = requireVaultKey(actor);
  const row = sqlite.prepare("SELECT key_version,nonce,ciphertext,tag FROM encrypted_entities WHERE owner_id=? AND entity_type=? AND entity_id=?").get(actor.ownerId, entityType, entityId) as ({ key_version: number } & Omit<CipherEnvelope, "v">) | undefined;
  if (!row) return undefined;
  return decryptEntity<T>(key, actor.ownerId, entityType, entityId, Number(row.key_version), { v: 1, nonce: row.nonce, ciphertext: row.ciphertext, tag: row.tag });
}
