import { describe, expect, it } from "vitest";
import { buildReportSnapshot } from "@/modules/ai/report-snapshot";

describe("AI report snapshot", () => {
  it("includes original-currency transfer flows and the actual exchange rate", () => {
    const snapshot = buildReportSnapshot({
      period: { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" },
      currencies: [{ currency: "HKD", expense_minor: "0", income_minor: "0", transfer_in_minor: "0", transfer_out_minor: "100000", net_cashflow_minor: "-100000" }],
      groups: [],
      income_groups: [],
      exchanges: [{ source_currency: "HKD", target_currency: "CNY", source_amount_minor: "100000", target_amount_minor: "92000", effective_rate: "0.92", inverse_rate: "1.08695652", count: 1 }],
      base: { missing_fx_count: 0 },
    }, "category");

    expect(snapshot.metrics).toContainEqual(expect.objectContaining({ metric_id: "currency_0_transfer_out", metric_type: "transfer_out", value_minor: "100000" }));
    expect(snapshot.metrics).toContainEqual(expect.objectContaining({ metric_id: "exchange_0_rate", metric_type: "actual_exchange_rate", effective_rate: "0.92", source_currency: "HKD", target_currency: "CNY" }));
    expect(snapshot.limitations.actual_exchange_rates_provided).toBe(1);
  });
});
