import { describe, expect, it } from "vitest";
import { createVaultSession, resolveVaultSession, revokeVaultSession } from "@/modules/vault/session";
import { attachAgentVaultGrant, grantAgentVault, revokeOwnerAgentVaultGrants } from "@/modules/vault/agent-session";

describe("vault sessions", () => {
  it("expires on idle/absolute TTL and revokes immediately", () => {
    const key = Buffer.alloc(32, 7); const token = createVaultSession("owner-session", key, 1, 1_000);
    expect(resolveVaultSession(token, "owner-session", 1_000)?.keyVersion).toBe(1);
    expect(resolveVaultSession(token, "owner-session", 1_000 + 15 * 60 * 1000)).toBeUndefined();
    const second = createVaultSession("owner-session", key, 1, 1_000); revokeVaultSession(second);
    expect(resolveVaultSession(second, "owner-session", 1_001)).toBeUndefined();
    key.fill(0);
  });
  it("grants only a bounded in-memory agent unlock and revokes it by owner", () => {
    const user = { ownerId: "owner-grant", actorType: "user" as const, actorId: "user", permissions: [], requestId: "request", vaultKey: Buffer.alloc(32, 4), vaultKeyVersion: 1 };
    const agent = { ownerId: "owner-grant", actorType: "agent" as const, actorId: "credential", permissions: [], requestId: "request" };
    const grant = grantAgentVault(user, "credential", 30); expect(Date.parse(grant.expires_at)).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    expect(attachAgentVaultGrant(agent).vaultKeyVersion).toBe(1);
    expect(attachAgentVaultGrant({ ...agent, ownerId: "other" })).not.toHaveProperty("vaultKey");
    revokeOwnerAgentVaultGrants("owner-grant"); expect(attachAgentVaultGrant(agent)).not.toHaveProperty("vaultKey");
    user.vaultKey.fill(0);
  });
});
