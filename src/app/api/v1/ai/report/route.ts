import { requireUser } from "@/modules/identity/supabase";
import { getSummary } from "@/modules/analytics/service";
import { createReport } from "@/modules/ai/provider";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin } from "@/modules/shared/security";

export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUser(request); const body = await request.json(); const summary = getSummary(actor, body); const snapshot = { metrics: summary.currencies.flatMap((c, i) => [{ metric_id: `currency_${i}_expense`, currency: c.currency, value_minor: c.expense_minor }, { metric_id: `currency_${i}_net`, currency: c.currency, value_minor: c.net_expense_minor }]), limitations: { missing_fx_count: summary.base?.missing_fx_count ?? 0 }, period: summary.period }; return Response.json(await createReport(actor, snapshot, `${body.start}/${body.end}`, body)); } catch (error) { return errorResponse(error); } }
