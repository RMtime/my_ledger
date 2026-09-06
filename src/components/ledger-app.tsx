"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, BookOpen, Bot, CircleDollarSign, Copy, Download, LogOut, Plus, ReceiptText, Save, Settings, Sparkles, Trash2, WifiOff, X } from "lucide-react";
import { DateTime } from "luxon";
import { formatMinor, parseMajorAmount } from "@/modules/ledger/money";
import { resolveSubmission } from "@/modules/ledger/submission-state";

type Tab = "entry" | "list" | "stats" | "settings";
type Kind = "expense" | "income" | "refund" | "transfer";
type Meta = { id: string; name: string; parent_id?: string | null; transaction_kind?: string; type?: string; currency?: string };
type Transaction = {
  id: string; kind: Kind; amount_minor: string; refundable_minor?: string; currency: string; occurred_at: string;
  occurred_timezone: string; time_precision: "date" | "minute" | "second"; category_id?: string | null;
  category_name?: string | null; payment_method?: string | null; account_id?: string | null; account_name?: string | null;
  channel_id?: string | null; channel_name?: string | null; merchant?: string | null; note?: string | null;
  related_transaction_id?: string | null; version: number; source: string;
};
type Bootstrap = { profile: { timezone: string; base_currency: string; email: string }; metadata: { categories: Meta[]; accounts: Meta[]; channels: Meta[] }; recent: { items: Transaction[] }; ai_configured: boolean };
type Summary = { currencies: Array<{ currency: string; expense_minor: string; refund_minor: string; income_minor: string; net_expense_minor: string; transaction_count: number }>; base: { currency: string; net_expense_minor: string; missing_fx_count: number; coverage: number } | null; groups: Array<{ label: string; currency: string; net_expense_minor: string; count: number }> };
type AiReport = { report: { observations: Array<{ metric_id: string; summary: string; action: string }>; limitations: string[] } };
type FormState = { kind: Kind; amount: string; currency: string; occurredLocal: string; timePrecision: "date" | "minute" | "second"; categoryId: string; paymentMethod: string; accountId: string; counterpartyAccountId: string; channelId: string; merchant: string; note: string; relatedId: string; idempotencyKey: string };
type EntryPhase = "draft" | "submitting" | "uncertain" | "saved";
type ListResponse = { items: Transaction[]; next_cursor: string | null };

const kindLabels: Record<Kind, string> = { expense: "支出", income: "收入", refund: "退款", transfer: "转账" };
const paymentLabels: Record<string, string> = { cash: "现金", card: "刷卡", apple_pay: "Apple Pay", alipay: "支付宝", wechat_pay: "微信支付", bank_transfer: "银行转账", other: "其他" };
const paymentMethods = Object.entries(paymentLabels);
const currencies = ["HKD", "CNY", "USD"];

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function freshForm(timezone = "Asia/Hong_Kong"): FormState {
  return { kind: "expense", amount: "", currency: "HKD", occurredLocal: DateTime.now().setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mm"), timePrecision: "minute", categoryId: "", paymentMethod: "", accountId: "", counterpartyAccountId: "", channelId: "", merchant: "", note: "", relatedId: "", idempotencyKey: crypto.randomUUID() };
}

function minorToMajor(value: string) {
  const amount = BigInt(value); const sign = amount < 0n ? "-" : ""; const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (response.status === 401) { window.location.replace("/login"); throw new ApiError("登录已过期", 401); }
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new ApiError(body?.error?.message ?? "请求失败", response.status);
  return body as T;
}

const fmtDate = (iso: string, timezone: string) => DateTime.fromISO(iso).setZone(timezone).toFormat("M月d日 HH:mm");
const iconFor = (tx: Transaction) => tx.kind === "income" ? "收" : tx.kind === "refund" ? "退" : tx.category_name?.slice(0, 1) ?? "支";

export function LedgerApp() {
  const [tab, setTab] = useState<Tab>("entry");
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const [copySeed, setCopySeed] = useState<{ tx: Transaction; key: string } | null>(null);
  const load = useCallback(async () => { try { setData(await api<Bootstrap>("/api/v1/bootstrap")); setError(""); } catch (caught) { setError((caught as Error).message); } }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const onConnectionChange = () => setOnline(navigator.onLine);
    window.addEventListener("online", onConnectionChange); window.addEventListener("offline", onConnectionChange);
    return () => { window.clearTimeout(timer); window.removeEventListener("online", onConnectionChange); window.removeEventListener("offline", onConnectionChange); };
  }, [load]);
  if (!data) return <main className="login"><div className="card login-card">{error ? <><p className="notice error">{error}</p><button className="btn primary full-button" onClick={load}>重试</button></> : <div className="spinner" />}</div></main>;
  return <main className="app"><div className="shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">寸</span>寸金</div><div className="today">{DateTime.now().setZone(data.profile.timezone).setLocale("zh-CN").toFormat("yyyy年M月d日 · cccc")}</div></header>
    {!online && <div className="notice pending"><WifiOff size={15} style={{ display: "inline", marginRight: 6 }} />当前离线。输入会保留在本页面内存中，但刷新或关闭页面可能丢失。</div>}
    <div hidden={tab !== "entry"}><EntryPanel key={copySeed?.key ?? "entry"} copy={copySeed?.tx ?? null} data={data} reload={load} onMore={() => setTab("list")} /></div>
    {tab === "list" && <ListPanel data={data} reload={load} copy={(tx) => { setCopySeed({ tx, key: crypto.randomUUID() }); setTab("entry"); }} />}
    {tab === "stats" && <StatsPanel data={data} />}{tab === "settings" && <SettingsPanel data={data} reload={load} />}
  </div><BottomNav tab={tab} setTab={setTab} /></main>;
}

function EntryPanel({ data, reload, onMore, copy }: { data: Bootstrap; reload: () => Promise<void>; onMore: () => void; copy: Transaction | null }) {
  const timezone = data.profile.timezone;
  const [form, setForm] = useState<FormState>(() => copy ? { ...freshForm(timezone), kind: copy.kind, amount: minorToMajor(copy.amount_minor), currency: copy.currency, categoryId: copy.category_id ?? "", paymentMethod: copy.payment_method ?? "", accountId: copy.account_id ?? "", channelId: copy.channel_id ?? "", merchant: copy.merchant ?? "", note: copy.note ?? "" } : freshForm(timezone));
  const [phase, setPhase] = useState<EntryPhase>("draft");
  const [status, setStatus] = useState<{ type: "" | "success" | "error" | "pending"; text: string }>(() => copy ? { type: "pending", text: "已复制为一笔新账，保存后会生成新记录。" } : { type: "", text: "" });
  const [continueAfter, setContinueAfter] = useState(false);
  const [nl, setNl] = useState(""); const [aiBusy, setAiBusy] = useState(false); const [aiSuggested, setAiSuggested] = useState(false);
  const [refundables, setRefundables] = useState<Transaction[]>([]);
  const busy = phase === "submitting";
  const categories = data.metadata.categories.filter((category) => category.transaction_kind === form.kind || (form.kind === "refund" && category.transaction_kind === "expense"));
  const set = (key: keyof FormState, value: string) => setForm((current) => ({ ...current, [key]: value }));
  useEffect(() => {
    if (form.kind !== "refund") return;
    const controller = new AbortController();
    void api<ListResponse>("/api/v1/transactions?refundable=true&limit=100", { signal: controller.signal }).then((result) => setRefundables(result.items)).catch((caught) => { if ((caught as Error).name !== "AbortError") setStatus({ type: "error", text: (caught as Error).message }); });
    return () => controller.abort();
  }, [form.kind]);
  function keypad(key: string) { if (key === "⌫") set("amount", form.amount.slice(0, -1)); else if (key === "." && !form.amount.includes(".")) set("amount", `${form.amount}.`); else if (/^\d$/.test(key) && (!form.amount.includes(".") || form.amount.split(".")[1].length < 2)) set("amount", form.amount === "0" ? key : form.amount + key); }
  function startNewEntry() { setForm(freshForm(timezone)); setAiSuggested(false); setNl(""); setPhase("draft"); setStatus({ type: "", text: "" }); }
  async function save(andContinue: boolean) {
    setContinueAfter(andContinue);
    if (!navigator.onLine) { setStatus({ type: "pending", text: "尚未提交。联网后可使用当前草稿重试；刷新页面可能丢失。" }); return; }
    setPhase("submitting"); setStatus({ type: "", text: "" });
    let result: { deduplicated: boolean };
    try {
      const occurred = DateTime.fromISO(form.occurredLocal, { zone: timezone }).toISO({ suppressMilliseconds: true });
      result = await api<{ deduplicated: boolean }>("/api/v1/transactions", { method: "POST", body: JSON.stringify({ kind: form.kind, amount_minor: parseMajorAmount(form.amount, form.currency), currency: form.currency, occurred_at: occurred, occurred_timezone: timezone, time_precision: form.timePrecision, category_id: form.categoryId || null, payment_method: form.paymentMethod || null, account_id: form.accountId || null, counterparty_account_id: form.counterpartyAccountId || null, channel_id: form.channelId || null, merchant: form.merchant || null, note: form.note || null, related_transaction_id: form.relatedId || null, idempotency_key: form.idempotencyKey, source: aiSuggested ? "ai_confirmed" : "manual" }) });
    } catch (caught) {
      const transition = resolveSubmission(form.idempotencyKey, caught instanceof ApiError ? "rejected" : "uncertain", andContinue, () => crypto.randomUUID());
      setPhase(transition.phase);
      if (caught instanceof ApiError) setStatus({ type: "error", text: caught.message });
      else setStatus({ type: "pending", text: "没有收到服务器确认。请保留当前内容并重试；系统会使用同一幂等键防止重复入账。" });
      return;
    }
    const transition = resolveSubmission(form.idempotencyKey, "confirmed", andContinue, () => crypto.randomUUID());
    setPhase(transition.phase); setStatus({ type: "success", text: result.deduplicated ? "这笔账此前已成功提交，没有重复入账。" : "已入账" });
    if (andContinue) { setForm({ ...freshForm(timezone), idempotencyKey: transition.idempotencyKey }); setAiSuggested(false); setNl(""); }
    else setForm((current) => ({ ...current, idempotencyKey: transition.idempotencyKey }));
    void reload().catch(() => setStatus({ type: "pending", text: "账目已保存，但刷新最近流水失败；稍后重新打开列表即可。" }));
  }
  async function extract() {
    setAiBusy(true);
    try {
      const result = await api<{ candidate: Record<string, string | null> }>("/api/v1/ai/extract", { method: "POST", body: JSON.stringify({ text: nl, timezone }) }); const candidate = result.candidate;
      setForm((current) => ({ ...current, kind: candidate.kind as Kind, amount: minorToMajor(String(candidate.amount_minor)), currency: candidate.currency ?? current.currency, occurredLocal: DateTime.fromISO(String(candidate.occurred_at)).setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mm"), merchant: candidate.merchant ?? "", note: candidate.note ?? "", paymentMethod: candidate.payment_method ?? "", idempotencyKey: crypto.randomUUID() }));
      setAiSuggested(true); setPhase("draft"); setStatus({ type: "pending", text: candidate.currency ? "AI 只生成了候选，请检查金额、币种和时间后再确认保存。" : "AI 未识别币种，已保留当前默认币种；请明确检查币种后再确认保存。" });
    } catch (caught) { setStatus({ type: "error", text: (caught as Error).message }); } finally { setAiBusy(false); }
  }
  if (phase === "saved") return <div className="grid"><section className="card entry saved-entry"><p className="eyebrow">SAVED</p><h1 className="entry-title">这笔账已安全入账</h1><div className="notice success">{status.text}</div><button className="btn primary full-button" onClick={startNewEntry}><Plus size={17} />再记一笔</button></section><RecentCard items={data.recent.items} timezone={timezone} onMore={onMore} /></div>;
  return <div className="grid"><section className="card entry">
    <p className="eyebrow">QUICK ENTRY</p><h1 className="entry-title">今天，记一笔</h1>
    {data.ai_configured && <div className="ai-row"><input className="control" value={nl} onChange={(event) => setNl(event.target.value)} placeholder="例如：昨晚美团麦当劳 38 元，支付宝" /><button className="btn secondary" onClick={extract} disabled={aiBusy || !nl.trim()}><Sparkles size={16} />{aiBusy ? "提取中" : "AI 提取"}</button></div>}
    <div className="kind-row">{(Object.keys(kindLabels) as Kind[]).map((kind) => <button key={kind} className={`seg ${form.kind === kind ? "active" : ""}`} onClick={() => { set("kind", kind); if (kind !== "refund") set("relatedId", ""); }}>{kindLabels[kind]}</button>)}</div>
    <div className="amount-wrap"><span className="currency-label">{form.currency}</span><input className="amount" inputMode="decimal" value={form.amount} onChange={(event) => set("amount", event.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" aria-label="金额" /></div>
    <div className="currency-row">{currencies.map((currency) => <button key={currency} className={`currency ${form.currency === currency ? "active" : ""}`} onClick={() => set("currency", currency)}>{currency}</button>)}</div>
    <p className="section-label">分类</p><div className="chip-row"><button className={`chip ${!form.categoryId ? "active" : ""}`} onClick={() => set("categoryId", "")}>未分类</button>{categories.map((category) => <button key={category.id} className={`chip ${form.categoryId === category.id ? "active" : ""}`} onClick={() => set("categoryId", category.id)}>{category.name}</button>)}</div>
    <div className="field-grid">
      <label className="field">发生时间<input type="datetime-local" className="control" value={form.occurredLocal} onChange={(event) => set("occurredLocal", event.target.value)} /></label>
      <label className="field">付款方式<select className="control" value={form.paymentMethod} onChange={(event) => set("paymentMethod", event.target.value)}><option value="">未指定</option>{paymentMethods.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label className="field">{form.kind === "transfer" ? "转出账户" : "付款账户"}<select className="control" value={form.accountId} onChange={(event) => set("accountId", event.target.value)}><option value="">未指定</option>{data.metadata.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>
      {form.kind === "transfer" && <label className="field">转入账户<select className="control" value={form.counterpartyAccountId} onChange={(event) => set("counterpartyAccountId", event.target.value)}><option value="">不追踪对手账户</option>{data.metadata.accounts.filter((account) => account.id !== form.accountId).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>}
      <label className="field">消费渠道<select className="control" value={form.channelId} onChange={(event) => set("channelId", event.target.value)}><option value="">未指定</option>{data.metadata.channels.map((channel) => <option value={channel.id} key={channel.id}>{channel.name}</option>)}</select></label>
      <label className="field">商家<input className="control" value={form.merchant} maxLength={160} onChange={(event) => set("merchant", event.target.value)} placeholder="实际商家" /></label>
      <label className="field">备注<input className="control" value={form.note} maxLength={1000} onChange={(event) => set("note", event.target.value)} placeholder="可选" /></label>
      {form.kind === "refund" && <label className="field full">原消费<select className="control" value={form.relatedId} onChange={(event) => { const original = refundables.find((item) => item.id === event.target.value); setForm((current) => ({ ...current, relatedId: event.target.value, currency: original?.currency ?? current.currency })); }} required><option value="">请选择可退款消费</option>{refundables.map((item) => <option key={item.id} value={item.id}>{fmtDate(item.occurred_at, timezone)} · {item.merchant || item.category_name || "支出"} · 可退 {formatMinor(item.refundable_minor ?? item.amount_minor, item.currency)}</option>)}</select>{!refundables.length && <small>当前没有可退款消费。</small>}</label>}
    </div>
    <div className="keypad">{["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].map((key) => <button className="key" key={key} onClick={() => keypad(key)}>{key}</button>)}</div>
    <div className="actions"><button className="btn secondary" disabled={busy || !form.amount || (form.kind === "refund" && !form.relatedId)} onClick={() => save(true)}>{continueAfter && busy ? "保存中…" : "保存并继续"}</button><button className="btn primary" disabled={busy || !form.amount || (form.kind === "refund" && !form.relatedId)} onClick={() => save(false)}><Save size={17} />{!continueAfter && busy ? "正在保存…" : phase === "uncertain" ? "重试保存" : "保存"}</button></div>
    {status.text && <div className={`notice ${status.type}`}>{status.text}</div>}
  </section><RecentCard items={data.recent.items} timezone={timezone} onMore={onMore} /></div>;
}

function RecentCard({ items, timezone, onMore }: { items: Transaction[]; timezone: string; onMore: () => void }) {
  return <aside className="card side-card"><div className="side-head"><div><p className="eyebrow">RECENT</p><h2>最近流水</h2></div><button className="link-btn" onClick={onMore}>全部</button></div>{items.length ? items.slice(0, 8).map((tx) => <TransactionRow key={tx.id} tx={tx} timezone={timezone} />) : <div className="empty"><ReceiptText size={28} /><p>还没有账目<br />第一笔会出现在这里</p></div>}</aside>;
}

function TransactionRow({ tx, timezone, actions }: { tx: Transaction; timezone: string; actions?: React.ReactNode }) {
  const sign = tx.kind === "expense" ? "−" : tx.kind === "transfer" ? "↔" : "+";
  return <div className="transaction"><div className="tx-icon">{iconFor(tx)}</div><div className="tx-main"><div className="tx-name">{tx.merchant || tx.category_name || kindLabels[tx.kind]}</div><div className="tx-meta">{fmtDate(tx.occurred_at, timezone)} · {tx.payment_method ? paymentLabels[tx.payment_method] ?? tx.payment_method : "未指定"}{tx.source === "mcp" ? " · Agent" : ""}</div>{actions}</div><div className={`tx-amount ${tx.kind}`}>{sign}{formatMinor(tx.amount_minor, tx.currency)}</div></div>;
}

function ListPanel({ data, reload, copy }: { data: Bootstrap; reload: () => Promise<void>; copy: (tx: Transaction) => void }) {
  const timezone = data.profile.timezone;
  const [filters, setFilters] = useState({ kind: "", categoryId: "", paymentMethod: "", accountId: "", channelId: "", dateFrom: "", dateTo: "", search: "" });
  const [items, setItems] = useState<Transaction[]>([]); const [nextCursor, setNextCursor] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [editing, setEditing] = useState<Transaction | null>(null); const [refreshSeed, setRefreshSeed] = useState(0);
  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: "30" });
    if (filters.kind) params.set("kind", filters.kind); if (filters.categoryId) params.set("category_id", filters.categoryId); if (filters.paymentMethod) params.set("payment_method", filters.paymentMethod); if (filters.accountId) params.set("account_id", filters.accountId); if (filters.channelId) params.set("channel_id", filters.channelId); if (filters.search.trim()) params.set("search", filters.search.trim());
    if (filters.dateFrom) params.set("date_from", DateTime.fromISO(filters.dateFrom, { zone: timezone }).startOf("day").toUTC().toISO()!);
    if (filters.dateTo) params.set("date_to", DateTime.fromISO(filters.dateTo, { zone: timezone }).plus({ days: 1 }).startOf("day").toUTC().toISO()!);
    return params.toString();
  }, [filters, timezone]);
  useEffect(() => {
    const controller = new AbortController(); const timer = window.setTimeout(() => { setLoading(true); setError(""); void api<ListResponse>(`/api/v1/transactions?${query}`, { signal: controller.signal }).then((result) => { setItems(result.items); setNextCursor(result.next_cursor); }).catch((caught) => { if ((caught as Error).name !== "AbortError") setError((caught as Error).message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, refreshSeed]);
  async function loadMore() { if (!nextCursor || loading) return; setLoading(true); try { const result = await api<ListResponse>(`/api/v1/transactions?${query}&cursor=${encodeURIComponent(nextCursor)}`); setItems((current) => [...current, ...result.items]); setNextCursor(result.next_cursor); } catch (caught) { setError((caught as Error).message); } finally { setLoading(false); } }
  async function remove(tx: Transaction) { if (!confirm("确认撤销这笔账？历史仍会保留在审计记录中。")) return; try { await api(`/api/v1/transactions/${tx.id}?version=${tx.version}`, { method: "DELETE" }); await reload(); setRefreshSeed((value) => value + 1); } catch (caught) { alert((caught as Error).message); } }
  const updateFilter = (key: keyof typeof filters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  return <section className="panel"><div className="card panel-card"><div className="side-head"><h1 className="panel-title">流水</h1><button className="link-btn" onClick={() => setFilters({ kind: "", categoryId: "", paymentMethod: "", accountId: "", channelId: "", dateFrom: "", dateTo: "", search: "" })}>清除筛选</button></div>
    <div className="filter-grid"><input className="control filter-search" value={filters.search} onChange={(event) => updateFilter("search", event.target.value)} placeholder="搜索商家、备注或分类" aria-label="搜索流水" /><select className="control" value={filters.kind} onChange={(event) => updateFilter("kind", event.target.value)}><option value="">全部类型</option>{Object.entries(kindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select className="control" value={filters.categoryId} onChange={(event) => updateFilter("categoryId", event.target.value)}><option value="">全部分类</option>{data.metadata.categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select><select className="control" value={filters.paymentMethod} onChange={(event) => updateFilter("paymentMethod", event.target.value)}><option value="">全部付款方式</option>{paymentMethods.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select className="control" value={filters.accountId} onChange={(event) => updateFilter("accountId", event.target.value)}><option value="">全部账户</option>{data.metadata.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select><select className="control" value={filters.channelId} onChange={(event) => updateFilter("channelId", event.target.value)}><option value="">全部渠道</option>{data.metadata.channels.map((channel) => <option value={channel.id} key={channel.id}>{channel.name}</option>)}</select><label className="field">开始日期<input type="date" className="control" value={filters.dateFrom} onChange={(event) => updateFilter("dateFrom", event.target.value)} /></label><label className="field">结束日期<input type="date" className="control" value={filters.dateTo} onChange={(event) => updateFilter("dateTo", event.target.value)} /></label></div>
    {error && <div className="notice error">{error}</div>}{items.length ? items.map((tx) => <TransactionRow key={tx.id} tx={tx} timezone={timezone} actions={<div className="row-actions"><button onClick={() => copy(tx)}><Copy size={13} />复制</button><button onClick={() => setEditing(tx)}><BookOpen size={13} />编辑</button><button onClick={() => remove(tx)}><Trash2 size={13} />撤销</button></div>} />) : !loading && <div className="empty">当前筛选下没有流水</div>}{loading && <div className="spinner list-spinner" />}{nextCursor && !loading && <button className="btn ghost full-button" onClick={loadMore}>加载更多</button>}
  </div>{editing && <EditSheet tx={editing} data={data} close={() => setEditing(null)} saved={async () => { setEditing(null); await reload(); setRefreshSeed((value) => value + 1); }} />}</section>;
}

function EditSheet({ tx, data, close, saved }: { tx: Transaction; data: Bootstrap; close: () => void; saved: () => Promise<void> }) {
  const timezone = data.profile.timezone;
  const [form, setForm] = useState({ amount: minorToMajor(tx.amount_minor), currency: tx.currency, occurredLocal: DateTime.fromISO(tx.occurred_at).setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mm"), timePrecision: tx.time_precision, categoryId: tx.category_id ?? "", paymentMethod: tx.payment_method ?? "", accountId: tx.account_id ?? "", channelId: tx.channel_id ?? "", merchant: tx.merchant ?? "", note: tx.note ?? "" });
  const [busy, setBusy] = useState(false); const categories = data.metadata.categories.filter((category) => category.transaction_kind === tx.kind || (tx.kind === "refund" && category.transaction_kind === "expense"));
  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  async function submit() { setBusy(true); try { await api(`/api/v1/transactions/${tx.id}`, { method: "PATCH", body: JSON.stringify({ version: tx.version, amount_minor: parseMajorAmount(form.amount, form.currency), currency: form.currency, occurred_at: DateTime.fromISO(form.occurredLocal, { zone: timezone }).toISO({ suppressMilliseconds: true }), occurred_timezone: timezone, time_precision: form.timePrecision, category_id: form.categoryId || null, payment_method: form.paymentMethod || null, account_id: form.accountId || null, channel_id: form.channelId || null, merchant: form.merchant || null, note: form.note || null }) }); await saved(); } catch (caught) { alert((caught as Error).message); setBusy(false); } }
  return <div className="overlay" onClick={close}><div className="sheet card" onClick={(event) => event.stopPropagation()}><button className="close" onClick={close} aria-label="关闭"><X /></button><p className="eyebrow">EDIT</p><h2 className="panel-title">修改账目</h2><div className="field-grid edit-grid"><label className="field">金额<input className="control" inputMode="decimal" value={form.amount} onChange={(event) => set("amount", event.target.value.replace(/[^\d.]/g, ""))} /></label><label className="field">币种<select className="control" value={form.currency} onChange={(event) => set("currency", event.target.value)}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label><label className="field">发生时间<input type="datetime-local" className="control" value={form.occurredLocal} onChange={(event) => set("occurredLocal", event.target.value)} /></label><label className="field">分类<select className="control" value={form.categoryId} onChange={(event) => set("categoryId", event.target.value)}><option value="">未分类</option>{categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label><label className="field">付款方式<select className="control" value={form.paymentMethod} onChange={(event) => set("paymentMethod", event.target.value)}><option value="">未指定</option>{paymentMethods.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label className="field">账户<select className="control" value={form.accountId} onChange={(event) => set("accountId", event.target.value)}><option value="">未指定</option>{data.metadata.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label><label className="field">渠道<select className="control" value={form.channelId} onChange={(event) => set("channelId", event.target.value)}><option value="">未指定</option>{data.metadata.channels.map((channel) => <option value={channel.id} key={channel.id}>{channel.name}</option>)}</select></label><label className="field">商家<input className="control" value={form.merchant} onChange={(event) => set("merchant", event.target.value)} /></label><label className="field full">备注<textarea className="control" rows={3} value={form.note} onChange={(event) => set("note", event.target.value)} /></label></div><button className="btn primary full-button" onClick={submit} disabled={busy || !form.amount}>{busy ? "保存中…" : "保存修改"}</button></div></div>;
}

function StatsPanel({ data }: { data: Bootstrap }) {
  const [summary, setSummary] = useState<Summary | null>(null); const [error, setError] = useState(""); const [report, setReport] = useState<AiReport | null>(null); const [reportBusy, setReportBusy] = useState(false); const [reportError, setReportError] = useState("");
  const period = useMemo(() => { const start = DateTime.now().setZone(data.profile.timezone).startOf("month"); return { start: start.toUTC().toISO()!, end: start.plus({ months: 1 }).toUTC().toISO()! }; }, [data.profile.timezone]);
  useEffect(() => { api<Summary>(`/api/v1/summary?start=${encodeURIComponent(period.start)}&end=${encodeURIComponent(period.end)}&group_by=category`).then(setSummary).catch((caught) => setError(caught.message)); }, [period]);
  if (error) return <div className="notice error">{error}</div>; if (!summary) return <div className="spinner" />;
  const max = Math.max(1, ...summary.groups.map((group) => Math.abs(Number(group.net_expense_minor))));
  const metricValue = (metricId: string) => { const match = /^currency_(\d+)_(expense|net)$/.exec(metricId); if (!match) return "指标不可用"; const currency = summary.currencies[Number(match[1])]; if (!currency) return "指标不可用"; return `${currency.currency} ${match[2] === "expense" ? "支出" : "净支出"} ${formatMinor(match[2] === "expense" ? currency.expense_minor : currency.net_expense_minor, currency.currency)}`; };
  async function createAiReport() { setReportBusy(true); setReportError(""); try { setReport(await api<AiReport>("/api/v1/ai/report", { method: "POST", body: JSON.stringify({ ...period, group_by: "category", currency_mode: "original" }) })); } catch (caught) { setReportError((caught as Error).message); } finally { setReportBusy(false); } }
  return <section className="panel"><div className="card panel-card"><p className="eyebrow">THIS MONTH</p><h1 className="panel-title">本月统计</h1>{summary.currencies.length ? summary.currencies.map((currency) => <div key={currency.currency} className="summary-block"><div className="stat-label">{currency.currency} 净支出</div><div className="summary-total">{formatMinor(currency.net_expense_minor, currency.currency)}</div><div className="summary-grid"><div className="stat"><div className="stat-label">支出</div><div className="stat-value">{formatMinor(currency.expense_minor, currency.currency)}</div></div><div className="stat"><div className="stat-label">退款</div><div className="stat-value">{formatMinor(currency.refund_minor, currency.currency)}</div></div><div className="stat"><div className="stat-label">收入</div><div className="stat-value">{formatMinor(currency.income_minor, currency.currency)}</div></div></div></div>) : <div className="empty">本月还没有账目</div>}{summary.base && summary.base.missing_fx_count > 0 && <div className="notice pending">有 {summary.base.missing_fx_count} 笔外币账目未换算；本位币覆盖率 {(summary.base.coverage * 100).toFixed(0)}%，未换算金额没有被当作 0。</div>}</div><div className="card panel-card"><h2 className="panel-title">分类分布</h2>{summary.groups.length ? summary.groups.map((group) => <div className="bar-row" key={`${group.label}-${group.currency}`}><div className="bar-label"><span>{group.label}</span><strong>{formatMinor(group.net_expense_minor, group.currency)}</strong></div><div className="bar"><div className="bar-fill" style={{ width: `${Math.max(3, Math.abs(Number(group.net_expense_minor)) / max * 100)}%` }} /></div></div>) : <div className="empty">暂无分类支出</div>}</div><div className="card panel-card"><h2 className="panel-title">AI 消费观察</h2>{data.ai_configured ? <><p className="muted-copy">模型只解释代码生成的统计快照；下方金额由账本代码插入。</p><button className="btn secondary" onClick={createAiReport} disabled={reportBusy || !summary.currencies.length}><Sparkles size={16} />{reportBusy ? "分析中…" : "生成本月观察"}</button>{reportError && <div className="notice error">{reportError}</div>}{report?.report.observations.map((item, index) => <div className="ai-observation" key={`${item.metric_id}-${index}`}><strong>{metricValue(item.metric_id)}</strong><p>{item.summary}</p><small>{item.action}</small></div>)}{report?.report.limitations.map((item, index) => <div className="notice pending" key={index}>{item}</div>)}</> : <div className="empty">尚未配置 AI；手工记账与确定性统计不受影响。</div>}</div></section>;
}

function SettingsPanel({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const [agents, setAgents] = useState<Array<Record<string, string>>>([]); const [token, setToken] = useState(""); const [name, setName] = useState(""); const [expirySeconds, setExpirySeconds] = useState("604800"); const [metaName, setMetaName] = useState(""); const [metaType, setMetaType] = useState("category");
  useEffect(() => { api<Array<Record<string, string>>>("/api/v1/agents").then(setAgents).catch(() => {}); }, []);
  async function issue() { const result = await api<{ token: string }>("/api/v1/agents", { method: "POST", body: JSON.stringify({ agent_name: name, permissions: ["metadata:read", "transactions:create"], expires_at: new Date(Date.now() + Number(expirySeconds) * 1000).toISOString() }) }); setToken(result.token); setName(""); setAgents(await api("/api/v1/agents")); }
  async function revoke(id: string) { if (!confirm("确认立即撤销这个 Agent 凭证？已配置该 PAT 的客户端将马上失效。")) return; await api("/api/v1/agents", { method: "DELETE", body: JSON.stringify({ id }) }); setAgents(await api("/api/v1/agents")); }
  async function addMeta() { await api("/api/v1/metadata", { method: "POST", body: JSON.stringify({ type: metaType, name: metaName, transaction_kind: "expense", currency: data.profile.base_currency }) }); setMetaName(""); await reload(); }
  async function logout() { await api("/api/v1/auth/logout", { method: "POST" }); window.location.replace("/login"); }
  return <section className="panel"><div className="card panel-card"><p className="eyebrow">PREFERENCES</p><h1 className="panel-title">设置</h1><div className="settings-row"><div>本位币<small>统计换算后的展示币种</small></div><strong>{data.profile.base_currency}</strong></div><div className="settings-row"><div>报表时区<small>所有日/月边界按此时区计算</small></div><strong>{data.profile.timezone}</strong></div><div className="settings-row"><div>AI 功能<small>缺少 API key 时不影响核心记账</small></div><strong>{data.ai_configured ? "已配置" : "未配置"}</strong></div></div><div className="card panel-card"><h2 className="panel-title">分类、账户与渠道</h2><div className="inline-form"><select className="control" value={metaType} onChange={(event) => setMetaType(event.target.value)}><option value="category">支出分类</option><option value="account">付款账户</option><option value="channel">消费渠道</option></select><input className="control" value={metaName} onChange={(event) => setMetaName(event.target.value)} placeholder="名称" /><button className="btn secondary" disabled={!metaName.trim()} onClick={addMeta}><Plus size={16} />添加</button></div></div><div className="card panel-card"><h2 className="panel-title">Agent 凭证</h2><p className="muted-copy">默认签发“读取元数据 + 新增账目”，不能查看流水或统计。PAT 只显示一次。</p><div className="inline-form"><input className="control" value={name} onChange={(event) => setName(event.target.value)} placeholder="Agent 名称" /><select className="control" aria-label="PAT 有效期" value={expirySeconds} onChange={(event) => setExpirySeconds(event.target.value)}><option value="3600">1 小时</option><option value="86400">1 天</option><option value="604800">7 天</option><option value="2592000">30 天</option></select><button className="btn secondary" disabled={!name.trim()} onClick={issue}><Bot size={17} />签发</button></div>{token && <div className="notice pending"><strong>立即保存：</strong><code className="token">{token}</code></div>}{agents.map((agent) => <div className="settings-row" key={agent.id}><div>{agent.agent_name}<small>{agent.token_prefix}… · {agent.revoked_at ? "已撤销" : agent.legacy_no_expiry ? "历史无到期时间" : `有效至 ${agent.expires_at}`}</small></div>{!agent.revoked_at && <button className="btn danger" onClick={() => revoke(agent.id)}>撤销</button>}</div>)}</div><div className="card panel-card"><h2 className="panel-title">数据与账户</h2><div className="export-row"><a className="btn ghost" href="/api/v1/export/json"><Download size={16} />JSON 导出</a><a className="btn ghost" href="/api/v1/export/csv"><Download size={16} />CSV 导出</a></div><button className="btn danger full-button" onClick={logout}><LogOut size={16} />退出登录</button></div></section>;
}

function BottomNav({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  const items: Array<[Tab, string, React.ReactNode]> = [["entry", "记一笔", <CircleDollarSign key="e" />], ["list", "流水", <ReceiptText key="l" />], ["stats", "统计", <BarChart3 key="s" />], ["settings", "设置", <Settings key="x" />]];
  return <nav className="bottom-nav">{items.map(([value, label, icon]) => <button key={value} className={`nav ${tab === value ? "active" : ""}`} onClick={() => setTab(value)}>{icon}{label}</button>)}</nav>;
}
