const exponents: Record<string, number> = { HKD: 2, CNY: 2, USD: 2 };

export function parseMajorAmount(value: string, currency: string): string {
  const exponent = exponents[currency.toUpperCase()];
  if (exponent === undefined) throw new Error(`不支持币种 ${currency}`);
  const normalized = value.trim().replaceAll(",", "");
  if (!/^\d+(?:\.\d*)?$/.test(normalized)) throw new Error("金额格式不正确");
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > exponent) throw new Error(`${currency} 最多 ${exponent} 位小数`);
  const minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt((fraction + "0".repeat(exponent)).slice(0, exponent));
  if (minor <= 0n) throw new Error("金额必须大于零");
  return minor.toString();
}

export function formatMinor(value: string | bigint, currency: string) {
  const exponent = exponents[currency] ?? 2;
  const amount = typeof value === "bigint" ? value : BigInt(value);
  const scale = 10n ** BigInt(exponent);
  return `${currency} ${(amount / scale).toString()}.${(amount % scale).toString().padStart(exponent, "0")}`;
}

export function convertHalfUp(amountMinor: bigint, rate: string): bigint {
  const [, decimal = ""] = rate.split(".");
  const scale = 10n ** BigInt(decimal.length);
  const numerator = BigInt(rate.replace(".", ""));
  return (amountMinor * numerator * 2n + scale) / (2n * scale);
}
