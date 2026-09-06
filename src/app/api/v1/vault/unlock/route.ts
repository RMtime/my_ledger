import { requireUser } from "@/modules/identity/supabase";
import { unlockVault } from "@/modules/vault/service";
import { setVaultCookie } from "@/modules/vault/http";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin, rateLimit } from "@/modules/shared/security";

export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUser(request); rateLimit(`vault-unlock:${actor.ownerId}`, 5, 60_000); const result = await unlockVault(actor, (await request.json()).passphrase); await setVaultCookie(result.token); return Response.json({ unlocked: true, key_version: result.key_version }, { headers: { "cache-control": "no-store" } }); } catch (error) { return errorResponse(error); } }
