import { requireUnlockedUser } from "@/modules/vault/http";
import { deleteTransaction, getTransaction, updateTransaction } from "@/modules/ledger/service";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin } from "@/modules/shared/security";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Params) { try { const actor = await requireUnlockedUser(request); return Response.json(getTransaction(actor, (await params).id), { headers: { "cache-control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function PATCH(request: Request, { params }: Params) { try { assertSameOrigin(request); const actor = await requireUnlockedUser(request); return Response.json(updateTransaction(actor, (await params).id, await request.json()), { headers: { "cache-control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function DELETE(request: Request, { params }: Params) { try { assertSameOrigin(request); const actor = await requireUnlockedUser(request); const version = Number(new URL(request.url).searchParams.get("version")); deleteTransaction(actor, (await params).id, version); return new Response(null, { status: 204 }); } catch (error) { return errorResponse(error); } }
