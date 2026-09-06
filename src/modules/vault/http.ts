import "server-only";
import { cookies } from "next/headers";
import type { ActorContext } from "@/modules/identity/types";
import { requireUser } from "@/modules/identity/supabase";
import { AppError } from "@/modules/shared/errors";
import { vaultInitialized } from "./entities";
import { resolveVaultSession } from "./session";

export const vaultCookieName = "my_ledger_vault";
export async function setVaultCookie(token: string) { (await cookies()).set(vaultCookieName, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 8 * 60 * 60, priority: "high" }); }
export async function clearVaultCookie() { (await cookies()).delete(vaultCookieName); }
export async function currentVaultToken() { return (await cookies()).get(vaultCookieName)?.value; }
export async function attachVaultSession(actor: ActorContext) { const token = (await cookies()).get(vaultCookieName)?.value; const session = resolveVaultSession(token, actor.ownerId); return session ? { ...actor, vaultKey: session.key, vaultKeyVersion: session.keyVersion } : actor; }
export async function requireUnlockedUser(request?: Request) { const actor = await attachVaultSession(await requireUser(request)); if (vaultInitialized(actor.ownerId) && !actor.vaultKey) throw new AppError("VAULT_LOCKED", "保险库已锁定，请先解锁", 423); return actor; }
