import { requireUnlockedUser } from "@/modules/vault/http";
import { getSummary } from "@/modules/analytics/service";
import { createReport } from "@/modules/ai/provider";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin } from "@/modules/shared/security";

export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUnlockedUser(request); const body = await request.json(); const summary = getSummary(actor, body); const dimension = String(body.group_by ?? "category");
    // 分类/账户/渠道/支付方式的分组标签属于确定性聚合，与现有隐私披露一致；
    // 商家名不在披露范围内，按商家分组时只发送匿名序号，保住"不发送逐笔商户"的承诺。
    const groupMetrics = summary.groups.map((group, index) => ({
      metric_id: `group_${index}`, dimension,
      label: dimension === "merchant" ? `商家 ${index + 1}` : group.label,
      currency: group.currency, value_minor: group.net_expense_minor, count: group.count,
    }));
    const snapshot = { metrics: [...summary.currencies.flatMap((c, i) => [{ metric_id: `currency_${i}_expense`, currency: c.currency, value_minor: c.expense_minor }, { metric_id: `currency_${i}_net`, currency: c.currency, value_minor: c.net_expense_minor }]), ...groupMetrics], limitations: { missing_fx_count: summary.base?.missing_fx_count ?? 0, merchant_labels_withheld: dimension === "merchant" }, period: summary.period }; return Response.json(await createReport(actor, snapshot, `${body.start}/${body.end}`, body)); } catch (error) { return errorResponse(error); } }
