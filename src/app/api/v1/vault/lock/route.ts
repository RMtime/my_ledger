import { requireUser } from "@/modules/identity/supabase";
import { clearVaultCookie } from "@/modules/vault/http";
import { revokeOwnerVaultSessions } from "@/modules/vault/session";
import { revokeOwnerAgentVaultGrants } from "@/modules/vault/agent-session";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin } from "@/modules/shared/security";

export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUser(request); revokeOwnerVaultSessions(actor.ownerId); revokeOwnerAgentVaultGrants(actor.ownerId); await clearVaultCookie(); return Response.json({ locked: true }); } catch (error) { return errorResponse(error); } }
