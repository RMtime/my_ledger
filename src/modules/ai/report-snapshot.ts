type ReportSummary = {
  period: unknown;
  currencies: Array<{
    currency: string;
    expense_minor: string;
    income_minor: string;
    transfer_in_minor: string;
    transfer_out_minor: string;
    net_cashflow_minor: string;
  }>;
  groups: Array<{ label: string; currency: string; net_expense_minor: string; count: number }>;
  income_groups: Array<{ label: string; currency: string; income_minor: string; count: number }>;
  exchanges: Array<{
    source_currency: string;
    target_currency: string;
    source_amount_minor: string;
    target_amount_minor: string;
    effective_rate: string;
    inverse_rate: string;
    count: number;
  }>;
  base: { missing_fx_count: number } | null;
};

export function buildReportSnapshot(summary: ReportSummary, dimension: string) {
  // 分类/账户/渠道/支付方式的分组标签属于确定性聚合，与现有隐私披露一致；
  // 商家名不在披露范围内，按商家分组时只发送匿名序号。
  const groupMetrics = summary.groups.map((group, index) => ({
    metric_id: `group_${index}`,
    dimension,
    label: dimension === "merchant" ? `商家 ${index + 1}` : group.label,
    currency: group.currency,
    value_minor: group.net_expense_minor,
    count: group.count,
  }));
  const incomeGroupMetrics = summary.income_groups.map((group, index) => ({
    metric_id: `income_group_${index}`,
    dimension,
    label: dimension === "merchant" ? `收入来源 ${index + 1}` : group.label,
    currency: group.currency,
    value_minor: group.income_minor,
    count: group.count,
  }));
  const currencyMetrics = summary.currencies.flatMap((currency, index) => [
    { metric_id: `currency_${index}_expense`, metric_type: "expense", currency: currency.currency, value_minor: currency.expense_minor },
    { metric_id: `currency_${index}_income`, metric_type: "income", currency: currency.currency, value_minor: currency.income_minor },
    { metric_id: `currency_${index}_transfer_in`, metric_type: "transfer_in", currency: currency.currency, value_minor: currency.transfer_in_minor },
    { metric_id: `currency_${index}_transfer_out`, metric_type: "transfer_out", currency: currency.currency, value_minor: currency.transfer_out_minor },
    { metric_id: `currency_${index}_balance`, metric_type: "net_cashflow", currency: currency.currency, value_minor: currency.net_cashflow_minor },
  ]);
  const exchangeMetrics = summary.exchanges.map((exchange, index) => ({
    metric_id: `exchange_${index}_rate`,
    metric_type: "actual_exchange_rate",
    ...exchange,
  }));
  return {
    metrics: [...currencyMetrics, ...exchangeMetrics, ...groupMetrics, ...incomeGroupMetrics],
    limitations: {
      missing_fx_count: summary.base?.missing_fx_count ?? 0,
      merchant_labels_withheld: dimension === "merchant",
      actual_exchange_rates_provided: exchangeMetrics.length,
    },
    period: summary.period,
  };
}
