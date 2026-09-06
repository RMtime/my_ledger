import { describe, expect, it } from "vitest";
import { crossRate, parseDecimal } from "@/modules/fx/rational";
import { parseHkmaRates } from "@/modules/fx/hkma";

describe("FX rational conversion", () => {
  it("uses integer half-up arithmetic and HKD cross rates", () => {
    expect(crossRate(100n, "USD", "HKD", { USD: parseDecimal("7.8") })).toBe(780n);
    expect(crossRate(100n, "USD", "CNY", { USD: parseDecimal("7.8"), CNY: parseDecimal("1.08") })).toBe(722n);
  });
  it("parses provider rows without trusting a future date", () => {
    const parsed = parseHkmaRates({ result: { records: [{ end_of_day: "2026-09-06", usd: "7.9000", cny: "1.0900" }, { end_of_day: "2026-09-05", usd: "7.8000", cny: "1.0800" }, { end_of_day: "2026-09-04", usd: "7.7000", cny: "1.0700" }] } }, "2026-09-05");
    expect(parsed.sourceDate).toBe("2026-09-05"); expect(parsed.ratesToHkd.USD.numerator).toBe(78000n);
    expect(parsed.rawHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
