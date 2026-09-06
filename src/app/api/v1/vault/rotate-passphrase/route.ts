import { requireUnlockedUser, setVaultCookie } from "@/modules/vault/http";
import { rotateVaultPassphrase } from "@/modules/vault/service";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin, rateLimit } from "@/modules/shared/security";

export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUnlockedUser(request); rateLimit(`vault-rotate:${actor.ownerId}`, 3, 5 * 60_000); const result = await rotateVaultPassphrase(actor, (await request.json()).new_passphrase); await setVaultCookie(result.token); return Response.json({ rotated: true, key_version: result.key_version }, { headers: { "cache-control": "no-store" } }); } catch (error) { return errorResponse(error); } }
