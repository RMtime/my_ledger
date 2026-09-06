import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { parseDecimal, type Rational } from "./rational";

export type HkmaRateSet = {
  sourceDate: string;
  ratesToHkd: Record<string, Rational>;
  rawHash: string;
};

const supported = ["USD", "CNY"] as const;

function records(payload: unknown) {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const result = root.result && typeof root.result === "object" ? root.result as Record<string, unknown> : undefined;
  const candidates = result?.records ?? result?.data ?? root.records ?? root.data;
  return Array.isArray(candidates)
    ? candidates.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
    : [];
}

export function parseHkmaRates(payload: unknown, requestedDate: string): HkmaRateSet {
  const eligible = records(payload)
    .map((row) => ({ row, date: String(row.end_of_day ?? row.date ?? "") }))
    .filter(({ date }) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= requestedDate)
    .sort((a, b) => b.date.localeCompare(a.date));
  const selected = eligible[0];
  if (!selected) throw new Error("HKMA returned no rate on or before the requested date");

  const ratesToHkd: Record<string, Rational> = {};
  for (const currency of supported) {
    const value = selected.row[currency.toLowerCase()];
    if (value !== undefined && value !== null && String(value).trim()) ratesToHkd[currency] = parseDecimal(String(value));
  }
  if (!ratesToHkd.USD || !ratesToHkd.CNY) throw new Error("HKMA response is missing USD or CNY rates");
  return {
    sourceDate: selected.date,
    ratesToHkd,
    rawHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

export async function fetchHkmaRates(date: string, fetcher: typeof fetch = fetch): Promise<HkmaRateSet> {
  const requested = DateTime.fromISO(date, { zone: "UTC" });
  const today = DateTime.utc().startOf("day");
  if (!requested.isValid || requested.toFormat("yyyy-MM-dd") !== date || requested > today) throw new Error("future or invalid fx date is not allowed");
  const endpoint = new URL(process.env.HKMA_API_URL ?? "https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily");
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "api.hkma.gov.hk") throw new Error("HKMA endpoint must use the official HTTPS host");
  endpoint.searchParams.set("start_date", requested.minus({ days: 10 }).toFormat("yyyy-MM-dd"));
  endpoint.searchParams.set("end_date", date);
  endpoint.searchParams.set("sort", "end_of_day");
  endpoint.searchParams.set("order", "desc");
  const response = await fetcher(endpoint, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`HKMA request failed: ${response.status}`);
  return parseHkmaRates(await response.json(), date);
}
