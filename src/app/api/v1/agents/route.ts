import { requireUser } from "@/modules/identity/supabase";
import { issueCredential, listCredentials, revokeCredential } from "@/modules/agents/service";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin, rateLimit } from "@/modules/shared/security";

export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { return Response.json(listCredentials(await requireUser(request)), { headers: { "cache-control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUser(request); rateLimit(`pat:${actor.ownerId}`, 10, 60_000); return Response.json(issueCredential(actor, await request.json()), { status: 201 }); } catch (error) { return errorResponse(error); } }
export async function DELETE(request: Request) { try { assertSameOrigin(request); const actor = await requireUser(request); revokeCredential(actor, String((await request.json()).id)); return new Response(null, { status: 204 }); } catch (error) { return errorResponse(error); } }
