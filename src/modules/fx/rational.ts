export type Rational = { numerator: bigint; denominator: bigint };
export function parseDecimal(value: string): Rational {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error("invalid decimal");
  const [whole, fraction = ""] = value.split("."); const denominator = 10n ** BigInt(fraction.length);
  return { numerator: BigInt(whole) * denominator + BigInt(fraction || "0"), denominator };
}
export function multiplyHalfUp(amountMinor: bigint, rate: Rational): bigint {
  const numerator = amountMinor * rate.numerator; const quotient = numerator / rate.denominator; const remainder = numerator % rate.denominator;
  return remainder * 2n >= rate.denominator ? quotient + 1n : quotient;
}
export function rateViaHkd(from: string, to: string, ratesToHkd: Record<string, Rational>): Rational {
  const fromRate = from === "HKD" ? { numerator: 1n, denominator: 1n } : ratesToHkd[from];
  const toRate = to === "HKD" ? { numerator: 1n, denominator: 1n } : ratesToHkd[to];
  if (!fromRate || !toRate) throw new Error("missing fx rate");
  return { numerator: fromRate.numerator * toRate.denominator, denominator: fromRate.denominator * toRate.numerator };
}
export function crossRate(amountMinor: bigint, from: string, to: string, ratesToHkd: Record<string, Rational>) {
  if (from === to) return amountMinor;
  return multiplyHalfUp(amountMinor, rateViaHkd(from, to, ratesToHkd));
}
