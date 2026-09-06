import { sqlite } from "@/db/client";
import { AppError } from "@/modules/shared/errors";
import type { ActorContext } from "@/modules/identity/types";
import { z } from "zod";
import { isoInstantSchema } from "@/modules/ledger/schemas";

const allowedGroups = { category: "COALESCE(c.name,'未分类')", payment_method: "COALESCE(t.payment_method,'未指定')", account: "COALESCE(a.name,'未指定')", channel: "COALESCE(ch.name,'未指定')", merchant: "COALESCE(t.merchant,'未指定')" } as const;
const summaryInputSchema = z.object({
  start: isoInstantSchema,
  end: isoInstantSchema,
  group_by: z.enum(["category", "payment_method", "account", "channel", "merchant"]).optional(),
  currency_mode: z.enum(["original", "base"]).optional(),
}).refine((value) => value.start < value.end, { message: "统计区间不正确" });

export function getSummary(actor: ActorContext, input: { start: string; end: string; group_by?: keyof typeof allowedGroups; currency_mode?: "original" | "base" }) {
  if (!actor.permissions.includes("analytics:read")) throw new AppError("FORBIDDEN", "当前凭证不能读取统计", 403);
  const parsed = summaryInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "统计区间不正确", 422, parsed.error.flatten());
  const filters = parsed.data;
  const rows = sqlite.prepare(`SELECT t.currency,
    SUM(CASE WHEN t.kind='expense' THEN t.amount_minor ELSE 0 END) expense_minor,
    SUM(CASE WHEN t.kind='refund' THEN t.amount_minor ELSE 0 END) refund_minor,
    SUM(CASE WHEN t.kind='income' THEN t.amount_minor ELSE 0 END) income_minor,
    COUNT(*) transaction_count
    FROM transactions t WHERE t.owner_id=? AND t.occurred_at>=? AND t.occurred_at<? AND t.deleted_at IS NULL
      AND t.kind IN ('expense','income','refund')
    GROUP BY t.currency ORDER BY t.currency`).all(actor.ownerId, filters.start, filters.end) as Array<Record<string, bigint | string | number>>;
  const currencies = rows.map((r) => ({
    currency: r.currency, expense_minor: String(r.expense_minor), refund_minor: String(r.refund_minor), income_minor: String(r.income_minor),
    net_expense_minor: (BigInt(r.expense_minor) - BigInt(r.refund_minor)).toString(), transaction_count: Number(r.transaction_count),
  }));
  const fx = sqlite.prepare(`SELECT p.base_currency,
    SUM(CASE WHEN t.kind='expense' THEN COALESCE(f.base_amount_minor, CASE WHEN t.currency=p.base_currency THEN t.amount_minor END) ELSE 0 END) expense_minor,
    SUM(CASE WHEN t.kind='refund' THEN COALESCE(f.base_amount_minor, CASE WHEN t.currency=p.base_currency THEN t.amount_minor END) ELSE 0 END) refund_minor,
    SUM(CASE WHEN t.kind='income' THEN COALESCE(f.base_amount_minor, CASE WHEN t.currency=p.base_currency THEN t.amount_minor END) ELSE 0 END) income_minor,
    SUM(CASE WHEN t.currency<>p.base_currency AND f.transaction_id IS NULL THEN 1 ELSE 0 END) missing_count,
    COUNT(*) total_count
    FROM transactions t JOIN profiles p ON p.id=t.owner_id LEFT JOIN transaction_fx f ON f.transaction_id=t.id AND f.base_currency=p.base_currency
    WHERE t.owner_id=? AND t.occurred_at>=? AND t.occurred_at<? AND t.deleted_at IS NULL
      AND t.kind IN ('expense','income','refund') GROUP BY p.base_currency`).get(actor.ownerId, filters.start, filters.end) as Record<string, bigint | string | number> | undefined;
  const groupExpression = allowedGroups[filters.group_by ?? "category"];
  const groups = sqlite.prepare(`SELECT ${groupExpression} label,t.currency,
    SUM(CASE WHEN t.kind='expense' THEN t.amount_minor WHEN t.kind='refund' THEN -t.amount_minor ELSE 0 END) net_expense_minor,COUNT(*) count
    FROM transactions t LEFT JOIN categories c ON c.owner_id=t.owner_id AND c.id=t.category_id
    LEFT JOIN accounts a ON a.owner_id=t.owner_id AND a.id=t.account_id LEFT JOIN channels ch ON ch.owner_id=t.owner_id AND ch.id=t.channel_id
    WHERE t.owner_id=? AND t.occurred_at>=? AND t.occurred_at<? AND t.deleted_at IS NULL AND t.kind IN ('expense','refund')
    GROUP BY label,t.currency ORDER BY ABS(net_expense_minor) DESC LIMIT 30`).all(actor.ownerId, filters.start, filters.end) as Array<Record<string, bigint | string | number>>;
  return {
    period: { start: filters.start, end: filters.end, semantics: "[start,end)", timezone: "由调用者将用户时区边界转换为 UTC" },
    currencies,
    base: fx ? { currency: String(fx.base_currency), expense_minor: String(fx.expense_minor ?? 0), refund_minor: String(fx.refund_minor ?? 0), income_minor: String(fx.income_minor ?? 0), net_expense_minor: (BigInt(fx.expense_minor ?? 0) - BigInt(fx.refund_minor ?? 0)).toString(), missing_fx_count: Number(fx.missing_count), coverage: Number(fx.total_count) ? (Number(fx.total_count) - Number(fx.missing_count)) / Number(fx.total_count) : 1 } : null,
    groups: groups.map((g) => ({ ...g, net_expense_minor: String(g.net_expense_minor), count: Number(g.count) })),
  };
}
