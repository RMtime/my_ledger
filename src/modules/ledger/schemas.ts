import { z } from "zod";

const uuid = z.uuid();
const optionalUuid = uuid.nullish();
const isoWithOffset = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)), "必须是包含时区偏移的 ISO 时间");
const timezone = z.string().min(1).refine((value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "无效 IANA 时区");
const amountMinor = z.string().regex(/^[1-9]\d*$/, "金额必须是正整数最小货币单位").refine((v) => BigInt(v) <= 999_999_999_999_999n, "金额超过上限");
export const paymentMethods = ["cash", "card", "apple_pay", "alipay", "wechat_pay", "bank_transfer", "other"] as const;

const transactionSchema = z.object({
  kind: z.enum(["expense", "income", "refund", "transfer"]),
  amount_minor: amountMinor,
  currency: z.string().length(3).transform((v) => v.toUpperCase()),
  occurred_at: isoWithOffset,
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
  fx: z.object({ base_currency: z.string().length(3), rate: z.string().regex(/^\d+(?:\.\d{1,12})?$/), rate_date: z.iso.date(), rate_source: z.string().max(80).default("manual") }).optional(),
});

export const createTransactionSchema = transactionSchema.superRefine((data, ctx) => {
  if (data.kind === "refund" && !data.related_transaction_id) ctx.addIssue({ code: "custom", path: ["related_transaction_id"], message: "退款必须关联原消费" });
  if (data.kind !== "transfer" && data.transfer_direction) ctx.addIssue({ code: "custom", path: ["transfer_direction"], message: "只有转账可以设置方向" });
  if (data.kind === "transfer" && data.counterparty_account_id && !data.account_id) ctx.addIssue({ code: "custom", path: ["account_id"], message: "成组转账必须选择转出账户" });
  if (data.account_id && data.counterparty_account_id === data.account_id) ctx.addIssue({ code: "custom", path: ["counterparty_account_id"], message: "转入与转出账户不能相同" });
});

export const updateTransactionSchema = transactionSchema.omit({ idempotency_key: true, source: true }).partial().extend({ version: z.number().int().positive() });
export const transactionFiltersSchema = z.object({
  start: z.string().optional(), end: z.string().optional(), kind: z.enum(["expense", "income", "refund", "transfer"]).optional(),
  currency: z.string().length(3).optional(), category_id: uuid.optional(), account_id: uuid.optional(), channel_id: uuid.optional(),
  cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
