import type { ActorContext } from "@/modules/identity/types";

type AgentGrant = { ownerId: string; key: Buffer; keyVersion: number; expiresAt: number };
const globalGrants = globalThis as unknown as { myLedgerAgentVaultGrants?: Map<string, AgentGrant> };
const grants = globalGrants.myLedgerAgentVaultGrants ?? new Map<string, AgentGrant>();
if (process.env.NODE_ENV !== "production") globalGrants.myLedgerAgentVaultGrants = grants;

export function grantAgentVault(actor: ActorContext, credentialId: string, minutes: number) {
  if (!actor.vaultKey || !actor.vaultKeyVersion) throw new Error("vault must be unlocked");
  const duration = Math.min(30, Math.max(1, Math.trunc(minutes))) * 60_000;
  revokeAgentVaultGrant(credentialId);
  grants.set(credentialId, { ownerId: actor.ownerId, key: Buffer.from(actor.vaultKey), keyVersion: actor.vaultKeyVersion, expiresAt: Date.now() + duration });
  return { credential_id: credentialId, expires_at: new Date(Date.now() + duration).toISOString() };
}

export function attachAgentVaultGrant(actor: ActorContext, now = Date.now()) {
  const grant = grants.get(actor.actorId);
  if (!grant || grant.ownerId !== actor.ownerId || grant.expiresAt <= now) { if (grant) revokeAgentVaultGrant(actor.actorId); return actor; }
  return { ...actor, vaultKey: grant.key, vaultKeyVersion: grant.keyVersion };
}

export function revokeAgentVaultGrant(credentialId: string) { const grant = grants.get(credentialId); if (grant) grant.key.fill(0); grants.delete(credentialId); }
export function revokeOwnerAgentVaultGrants(ownerId: string) { for (const [id, grant] of grants) if (grant.ownerId === ownerId) revokeAgentVaultGrant(id); }
