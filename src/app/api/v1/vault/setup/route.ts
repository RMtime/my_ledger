import { requireUser } from "@/modules/identity/supabase";
import { initializeVault } from "@/modules/vault/service";
import { setVaultCookie } from "@/modules/vault/http";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin, rateLimit } from "@/modules/shared/security";

export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUser(request); rateLimit(`vault-setup:${actor.ownerId}`, 3, 60_000); const result = await initializeVault(actor, (await request.json()).passphrase); await setVaultCookie(result.token); return Response.json({ recovery_key: result.recovery_key, key_version: result.key_version }, { status: 201, headers: { "cache-control": "no-store" } }); } catch (error) { return errorResponse(error); } }
