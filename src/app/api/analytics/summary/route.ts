import { DateTime } from "luxon";
import { requireUnlockedUser } from "@/modules/vault/http";
import { getProfile } from "@/modules/profile/service";
import { getSummary } from "@/modules/analytics/service";
import { AppError, errorResponse } from "@/modules/shared/errors";
import { listTransactions } from "@/modules/ledger/service";
import { ensureFxSnapshots, type FxTransaction } from "@/modules/fx/service";

export const dynamic = "force-dynamic";
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
export async function GET(request: Request) {
  try {
    const actor = await requireUnlockedUser(request); const profile = getProfile(actor); if (!profile) throw new AppError("NOT_FOUND", "用户资料不存在", 404);
    const params = new URL(request.url).searchParams; const timezone = String(profile.timezone ?? "UTC"); const month = params.get("month") ?? DateTime.now().setZone(timezone).toFormat("yyyy-MM");
    if (!monthPattern.test(month)) throw new AppError("VALIDATION_ERROR", "month 必须是 YYYY-MM", 422);
    const start = DateTime.fromISO(`${month}-01`, { zone: timezone }).startOf("month"); const end = start.plus({ months: 1 });
    const groupBy = (params.get("group_by") ?? "category") as "category" | "payment_method" | "account" | "channel" | "merchant";
    if (!["category", "payment_method", "account", "channel", "merchant"].includes(groupBy)) throw new AppError("VALIDATION_ERROR", "group_by 不正确", 422);
    const currencyMode = params.get("currency_mode") === "base" ? "base" : "original"; const displayCurrency = (params.get("display_currency")?.toUpperCase() ?? String(profile.base_currency ?? "HKD").toUpperCase()) as "HKD" | "CNY" | "USD";
    if (!["HKD", "CNY", "USD"].includes(displayCurrency)) throw new AppError("VALIDATION_ERROR", "display_currency 不正确", 422);
    const categoryLevel = params.get("category_level") === "leaf" ? "leaf" : "top";
    const startUtc = start.toUTC().toISO()!; const endUtc = end.toUTC().toISO()!;
    if (currencyMode === "base" && actor.vaultKey) {
      const rows: FxTransaction[] = []; let cursor: string | null = null;
      do { const page = listTransactions(actor, { start: startUtc, end: endUtc, limit: 100, cursor: cursor ?? undefined }); rows.push(...page.items as FxTransaction[]); cursor = page.next_cursor; } while (cursor);
      await ensureFxSnapshots(actor, rows, displayCurrency);
    }
    const summary = getSummary(actor, { start: startUtc, end: endUtc, group_by: groupBy, currency_mode: currencyMode, display_currency: displayCurrency, category_level: categoryLevel });
    return Response.json({ ...summary, period: { ...summary.period, month, timezone }, currency_mode: currencyMode, display_currency: displayCurrency, category_level: categoryLevel }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
