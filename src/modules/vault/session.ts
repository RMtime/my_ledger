import { randomBytes } from "node:crypto";

type VaultSession = { ownerId: string; key: Buffer; keyVersion: number; idleExpiresAt: number; absoluteExpiresAt: number };
const globalSessions = globalThis as unknown as { myLedgerVaultSessions?: Map<string, VaultSession> };
const sessions = globalSessions.myLedgerVaultSessions ?? new Map<string, VaultSession>();
if (process.env.NODE_ENV !== "production") globalSessions.myLedgerVaultSessions = sessions;
const idleMs = 15 * 60 * 1000; const absoluteMs = 8 * 60 * 60 * 1000;

export function createVaultSession(ownerId: string, key: Buffer, keyVersion: number, now = Date.now()) {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { ownerId, key: Buffer.from(key), keyVersion, idleExpiresAt: now + idleMs, absoluteExpiresAt: now + absoluteMs });
  return token;
}

export function resolveVaultSession(token: string | undefined, ownerId: string, now = Date.now()) {
  if (!token) return undefined; const session = sessions.get(token);
  if (!session || session.ownerId !== ownerId || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) { if (session) { session.key.fill(0); sessions.delete(token); } return undefined; }
  session.idleExpiresAt = Math.min(now + idleMs, session.absoluteExpiresAt);
  return { key: session.key, keyVersion: session.keyVersion, absoluteExpiresAt: session.absoluteExpiresAt };
}

export function revokeVaultSession(token?: string) { if (!token) return; const session = sessions.get(token); if (session) session.key.fill(0); sessions.delete(token); }
export function revokeOwnerVaultSessions(ownerId: string) { for (const [token, session] of sessions) if (session.ownerId === ownerId) { session.key.fill(0); sessions.delete(token); } }
