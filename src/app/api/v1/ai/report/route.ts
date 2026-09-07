import { requireUnlockedUser } from "@/modules/vault/http";
import { getSummary } from "@/modules/analytics/service";
import { createReport } from "@/modules/ai/provider";
import { buildReportSnapshot } from "@/modules/ai/report-snapshot";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin } from "@/modules/shared/security";

export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUnlockedUser(request); const body = await request.json(); const summary = getSummary(actor, body); const snapshot = buildReportSnapshot(summary, String(body.group_by ?? "category")); return Response.json(await createReport(actor, snapshot, `${body.start}/${body.end}`, body)); } catch (error) { return errorResponse(error); } }
