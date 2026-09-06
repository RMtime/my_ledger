import { requireUnlockedUser } from "@/modules/vault/http";
import { getSummary } from "@/modules/analytics/service";
import { errorResponse } from "@/modules/shared/errors";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { const params = new URL(request.url).searchParams; const actor = await requireUnlockedUser(request); return Response.json(getSummary(actor, { start: params.get("start") ?? "", end: params.get("end") ?? "", group_by: (params.get("group_by") ?? "category") as "category" }), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
