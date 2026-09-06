import { requireUnlockedUser } from "@/modules/vault/http";
import { createTransaction, listTransactions } from "@/modules/ledger/service";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin, rateLimit } from "@/modules/shared/security";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { const actor = await requireUnlockedUser(request); return Response.json(listTransactions(actor, Object.fromEntries(new URL(request.url).searchParams)), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try { assertSameOrigin(request); const actor = await requireUnlockedUser(request); rateLimit(`write:${actor.ownerId}`, 60, 60_000); const body=await request.json(); return Response.json(createTransaction(actor, { ...body, source:body.source==="ai_confirmed"?"ai_confirmed":"manual" }), { status: 201, headers: { "cache-control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
