import { z } from "zod";
import { normalizeUtcInstant } from "@/modules/shared/time";

const uuid = z.uuid();
const optionalUuid = uuid.nullish();
export const isoInstantSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeUtcInstant(value);
  if (!normalized) {
    ctx.addIssue({ code: "custom", message: "必须是有效且包含时区偏移的 ISO 时间" });
    return z.NEVER;
  }
  return normalized;
});
const timezone = z.string().min(1).refine((value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "无效 IANA 时区");
const amountMinor = z.string().regex(/^[1-9]\d*$/, "金额必须是正整数最小货币单位").refine((v) => BigInt(v) <= 999_999_999_999_999n, "金额超过上限");
const positiveRate = z.string().regex(/^\d+(?:\.\d{1,12})?$/).refine((value) => BigInt(value.replace(".", "")) > 0n, "汇率必须大于零");
export const paymentMethods = ["cash", "card", "apple_pay", "alipay", "wechat_pay", "bank_transfer", "other"] as const;

const transactionSchema = z.object({
  kind: z.enum(["expense", "income", "refund", "transfer"]),
  amount_minor: amountMinor,
  currency: z.string().length(3).transform((v) => v.toUpperCase()),
  occurred_at: isoInstantSchema,
  occurred_timezone: timezone,
  time_precision: z.enum(["date", "minute", "second"]).default("minute"),
  category_id: optionalUuid,
  payment_method: z.enum(paymentMethods).nullish(),
  account_id: optionalUuid,
  channel_id: optionalUuid,
  merchant: z.string().trim().max(160).nullish(),
  note: z.string().trim().max(1000).nullish(),
  related_transaction_id: optionalUuid,
  transfer_group_id: optionalUuid,
  transfer_direction: z.enum(["in", "out"]).nullish(),
  counterparty_account_id: optionalUuid,
  source: z.enum(["manual", "ai_confirmed", "mcp"]).default("manual"),
  idempotency_key: z.string().min(8).max(160),
  fx: z.object({ base_currency: z.string().length(3).transform((value) => value.toUpperCase()), rate: positiveRate, rate_date: z.iso.date(), rate_source: z.string().trim().min(1).max(80).default("manual") }).optional(),
});

export const createTransactionSchema = transactionSchema.superRefine((data, ctx) => {
  if (data.kind === "refund" && !data.related_transaction_id) ctx.addIssue({ code: "custom", path: ["related_transaction_id"], message: "退款必须关联原消费" });
  if (data.kind !== "transfer" && data.transfer_direction) ctx.addIssue({ code: "custom", path: ["transfer_direction"], message: "只有转账可以设置方向" });
  if (data.kind === "transfer" && data.counterparty_account_id && !data.account_id) ctx.addIssue({ code: "custom", path: ["account_id"], message: "成组转账必须选择转出账户" });
  if (data.kind === "transfer" && data.fx) ctx.addIssue({ code: "custom", path: ["fx"], message: "首版成组转账不接受折算快照" });
  if (data.account_id && data.counterparty_account_id === data.account_id) ctx.addIssue({ code: "custom", path: ["counterparty_account_id"], message: "转入与转出账户不能相同" });
});

export const updateTransactionSchema = transactionSchema.pick({
  amount_minor: true,
  currency: true,
  occurred_at: true,
  occurred_timezone: true,
  time_precision: true,
  category_id: true,
  payment_method: true,
  account_id: true,
  channel_id: true,
  merchant: true,
  note: true,
  fx: true,
}).partial().extend({ version: z.number().int().positive() }).strict();
export const transactionFiltersSchema = z.object({
  start: isoInstantSchema.optional(), end: isoInstantSchema.optional(), kind: z.enum(["expense", "income", "refund", "transfer"]).optional(),
  date_from: isoInstantSchema.optional(), date_to: isoInstantSchema.optional(),
  currency: z.string().length(3).transform((value) => value.toUpperCase()).optional(), category_id: uuid.optional(), account_id: uuid.optional(), channel_id: uuid.optional(),
  payment_method: z.enum(paymentMethods).optional(), search: z.string().trim().max(120).optional(),
  refundable: z.union([z.boolean(), z.enum(["true", "false"])]).transform((value) => value === true || value === "true").optional(),
  cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
}).superRefine((value, ctx) => {
  const start = value.start ?? value.date_from;
  const end = value.end ?? value.date_to;
  if (value.start && value.date_from) ctx.addIssue({ code: "custom", path: ["date_from"], message: "不能同时使用 start 和 date_from" });
  if (value.end && value.date_to) ctx.addIssue({ code: "custom", path: ["date_to"], message: "不能同时使用 end 和 date_to" });
  if (start && end && start >= end) ctx.addIssue({ code: "custom", message: "筛选区间不正确" });
});
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
