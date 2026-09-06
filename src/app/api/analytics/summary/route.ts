import { DateTime } from "luxon";
import { requireUnlockedUser } from "@/modules/vault/http";
import { getProfile } from "@/modules/profile/service";
import { ensureSummaryFx, getSummary } from "@/modules/analytics/service";
import { AppError, errorResponse } from "@/modules/shared/errors";
import { normalizeUtcInstant } from "@/modules/shared/time";

export const dynamic = "force-dynamic";
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
function resolveRange(params: URLSearchParams, timezone: string) {
  const rawStart = params.get("start"); const rawEnd = params.get("end");
  if (rawStart || rawEnd) {
    const start = rawStart ? normalizeUtcInstant(rawStart) : null; const end = rawEnd ? normalizeUtcInstant(rawEnd) : null;
    if (!start || !end) throw new AppError("VALIDATION_ERROR", "start 与 end 必须成对提供且是含时区偏移的 ISO 时间", 422);
    if (start >= end) throw new AppError("VALIDATION_ERROR", "统计区间不正确", 422);
    return { start, end, month: null as string | null };
  }
  const month = params.get("month") ?? DateTime.now().setZone(timezone).toFormat("yyyy-MM");
  if (!monthPattern.test(month)) throw new AppError("VALIDATION_ERROR", "month 必须是 YYYY-MM", 422);
  const start = DateTime.fromISO(`${month}-01`, { zone: timezone }).startOf("month");
  return { start: start.toUTC().toISO()!, end: start.plus({ months: 1 }).toUTC().toISO()!, month };
}

export async function GET(request: Request) {
  try {
    const actor = await requireUnlockedUser(request); const profile = getProfile(actor); if (!profile) throw new AppError("NOT_FOUND", "用户资料不存在", 404);
    const params = new URL(request.url).searchParams; const timezone = String(profile.timezone ?? "UTC");
    // 任意区间优先于 month。两者都必须落到与账目入口相同的 UTC 标准化，避免跨时区月界口径漂移。
    const range = resolveRange(params, timezone);
    const groupBy = (params.get("group_by") ?? "category") as "category" | "payment_method" | "account" | "channel" | "merchant";
    if (!["category", "payment_method", "account", "channel", "merchant"].includes(groupBy)) throw new AppError("VALIDATION_ERROR", "group_by 不正确", 422);
    const currencyMode = params.get("currency_mode") === "base" ? "base" : "original"; const displayCurrency = (params.get("display_currency")?.toUpperCase() ?? String(profile.base_currency ?? "HKD").toUpperCase()) as "HKD" | "CNY" | "USD";
    if (!["HKD", "CNY", "USD"].includes(displayCurrency)) throw new AppError("VALIDATION_ERROR", "display_currency 不正确", 422);
    const categoryLevel = params.get("category_level") === "leaf" ? "leaf" : "top";
    const { start: startUtc, end: endUtc, month } = range;
    await ensureSummaryFx(actor, { start: startUtc, end: endUtc, currency_mode: currencyMode, display_currency: displayCurrency });
    const summary = getSummary(actor, { start: startUtc, end: endUtc, group_by: groupBy, currency_mode: currencyMode, display_currency: displayCurrency, category_level: categoryLevel });
    return Response.json({ ...summary, period: { ...summary.period, month, timezone }, currency_mode: currencyMode, display_currency: displayCurrency, category_level: categoryLevel }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
