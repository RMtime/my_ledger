import { requireUser } from "@/modules/identity/supabase";
import { recoverVault } from "@/modules/vault/service";
import { setVaultCookie } from "@/modules/vault/http";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin, rateLimit } from "@/modules/shared/security";

export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUser(request); rateLimit(`vault-recover:${actor.ownerId}`, 3, 5 * 60_000); const body = await request.json(); const result = await recoverVault(actor, body.recovery_key, body.new_passphrase); await setVaultCookie(result.token); return Response.json({ recovered: true, key_version: result.key_version }, { headers: { "cache-control": "no-store" } }); } catch (error) { return errorResponse(error); } }
