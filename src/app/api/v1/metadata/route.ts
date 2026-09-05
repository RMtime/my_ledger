import { requireUser } from "@/modules/identity/supabase";
import { createMetadata, listMetadata } from "@/modules/ledger/metadata";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin } from "@/modules/shared/security";

export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { return Response.json(listMetadata(await requireUser(request)), { headers: { "cache-control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUser(request); const body = await request.json(); return Response.json(createMetadata(actor, body.type, body), { status: 201 }); } catch (error) { return errorResponse(error); } }
