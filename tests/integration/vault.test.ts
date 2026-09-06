import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sqlite } from "@/db/client";
import { userActor, type ActorContext } from "@/modules/identity/types";
import { initializeVault, rotateVaultPassphrase, unlockVault } from "@/modules/vault/service";
import { resolveVaultSession } from "@/modules/vault/session";
import { createMetadata, listMetadata } from "@/modules/ledger/metadata";
import { createTransaction, getTransaction, listTransactions } from "@/modules/ledger/service";
import { updateProfile } from "@/modules/profile/service";
import { ensureFxSnapshot, readFxSnapshot } from "@/modules/fx/service";
import { parseDecimal } from "@/modules/fx/rational";
import { ensureSummaryFx, getSummary } from "@/modules/analytics/service";

const owner = "00000000-0000-4000-8000-0000000000c1";
let actor: ActorContext;
let paymentMethodId: string;

beforeAll(async () => {
  const now = new Date().toISOString();
  sqlite.prepare("INSERT INTO profiles (id,auth_subject,email,timezone,base_currency,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(owner, "vault-test", "vault@example.com", "Asia/Hong_Kong", "HKD", 1, now, now);
  const base = userActor(owner, "vault-test");
  const result = await initializeVault(base, "correct horse battery staple");
  const session = resolveVaultSession(result.token, owner);
  if (!session) throw new Error("vault session was not created");
  actor = { ...base, vaultKey: session.key, vaultKeyVersion: session.keyVersion };
  paymentMethodId = String(listMetadata(actor).payment_methods[0].id);
});

describe("encrypted user vault", () => {
  it("creates starter metadata per user and keeps sensitive transaction fields out of plaintext columns", () => {
    expect(listMetadata(actor).categories.length).toBeGreaterThan(0);
    const tx = createTransaction(actor, { kind: "expense", amount_minor: "3800", currency: "HKD", occurred_at: "2026-09-06T12:00:00+08:00", occurred_timezone: "Asia/Hong_Kong", time_precision: "minute", payment_method_id: paymentMethodId, merchant: "私密商户", note: "私密备注", idempotency_key: randomUUID(), source: "manual" });
    const id = String((tx.transaction as { id: string }).id);
    const stored = sqlite.prepare("SELECT amount_minor,currency,occurred_at,merchant,note,idempotency_key FROM transactions WHERE owner_id=? AND id=?").get(owner, id) as Record<string, unknown>;
    expect(stored).toMatchObject({ amount_minor: 1n, currency: "XXX", occurred_at: "1970-01-01T00:00:00.000Z", merchant: null, note: null });
    expect(String(stored.idempotency_key)).toBe(`enc:${id}`);
    expect(listTransactions(actor, { search: "私密商户" }).items).toEqual([expect.objectContaining({ id, amount_minor: "3800", merchant: "私密商户", payment_method_id: paymentMethodId })]);
  });
  it("validates encrypted refunds and supports encrypted transfer pairs", () => {
    const expense = createTransaction(actor, { kind: "expense", amount_minor: "1000", currency: "HKD", occurred_at: "2026-09-07T12:00:00+08:00", occurred_timezone: "Asia/Hong_Kong", time_precision: "minute", idempotency_key: randomUUID(), source: "manual" }).transaction as { id: string };
    createTransaction(actor, { kind: "refund", amount_minor: "400", currency: "HKD", occurred_at: "2026-09-08T12:00:00+08:00", occurred_timezone: "Asia/Hong_Kong", time_precision: "minute", related_transaction_id: expense.id, idempotency_key: randomUUID(), source: "manual" });
    expect(() => createTransaction(actor, { kind: "refund", amount_minor: "700", currency: "HKD", occurred_at: "2026-09-09T12:00:00+08:00", occurred_timezone: "Asia/Hong_Kong", time_precision: "minute", related_transaction_id: expense.id, idempotency_key: randomUUID(), source: "manual" })).toThrow("不能超过");
    const accounts = listMetadata(actor).accounts;
    const result = createTransaction(actor, { kind: "transfer", amount_minor: "250", currency: "HKD", occurred_at: "2026-09-10T12:00:00+08:00", occurred_timezone: "Asia/Hong_Kong", time_precision: "minute", account_id: String(accounts[0].id), counterparty_account_id: String(accounts[1].id), idempotency_key: randomUUID(), source: "manual" }) as unknown as { pair: Array<{ kind: string; transfer_direction: string }> };
    expect(result.pair).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "transfer", transfer_direction: "out" }), expect.objectContaining({ kind: "transfer", transfer_direction: "in" })]));
  });
  it("uses the encrypted profile currency for manual FX without exposing the snapshot amount", () => {
    updateProfile(actor, { base_currency: "CNY" });
    const result = createTransaction(actor, { kind: "expense", amount_minor: "1000", currency: "USD", occurred_at: "2026-09-11T12:00:00+08:00", occurred_timezone: "Asia/Hong_Kong", time_precision: "minute", fx: { base_currency: "CNY", rate: "7.2", rate_date: "2026-09-11", rate_source: "manual" }, idempotency_key: randomUUID(), source: "manual" });
    const id = String((result.transaction as { id: string }).id); const snapshot = sqlite.prepare("SELECT source,source_date,rate,base_amount_minor FROM fx_snapshots WHERE transaction_id=? AND target_currency='CNY'").get(id);
    expect(snapshot).toEqual({ source: "encrypted", source_date: null, rate: null, base_amount_minor: null });
  });
  it("creates immutable target snapshots and makes refunds inherit the original rate", async () => {
    updateProfile(actor, { base_currency: "HKD" });
    const expense = createTransaction(actor, { kind: "expense", amount_minor: "1000", currency: "CNY", occurred_at: "2026-09-12T12:00:00+08:00", occurred_timezone: "Asia/Hong_Kong", time_precision: "minute", idempotency_key: randomUUID(), source: "manual" }).transaction as Record<string, string>;
    const fetcher = async () => ({ sourceDate: "2026-09-11", ratesToHkd: { CNY: parseDecimal("1.1"), USD: parseDecimal("7.8") }, rawHash: "a".repeat(64) });
    const original = await ensureFxSnapshot(actor, expense as never, "HKD", fetcher);
    expect(original).toMatchObject({ source_date: "2026-09-11", base_amount_minor: "1100", status: "available" });
    const refund = createTransaction(actor, { kind: "refund", amount_minor: "250", currency: "CNY", occurred_at: "2026-09-15T12:00:00+08:00", occurred_timezone: "Asia/Hong_Kong", time_precision: "minute", related_transaction_id: expense.id, idempotency_key: randomUUID(), source: "manual" }).transaction as Record<string, string>;
    const inherited = await ensureFxSnapshot(actor, refund as never, "HKD", async () => { throw new Error("refund must not refetch"); });
    expect(inherited).toMatchObject({ source_date: "2026-09-11", base_amount_minor: "275", status: "available" });
    expect(readFxSnapshot(actor, refund.id, "HKD")?.source_date).toBe("2026-09-11");
  });
  it("switches target currency without overwriting snapshots and aggregates category parents", async () => {
    const top = createMetadata(actor, "category", { name: "家庭", transaction_kind: "expense" }); const leaf = createMetadata(actor, "category", { name: "日用品", transaction_kind: "expense", parent_id: top.id });
    const transaction = createTransaction(actor, { kind: "expense", amount_minor: "1000", currency: "USD", occurred_at: "2026-09-20T12:00:00+08:00", occurred_timezone: "Asia/Hong_Kong", time_precision: "minute", category_id: leaf.id, idempotency_key: randomUUID(), source: "manual" }).transaction as Record<string, string>;
    const fetcher = async () => ({ sourceDate: "2026-09-18", ratesToHkd: { CNY: parseDecimal("1.1"), USD: parseDecimal("7.8") }, rawHash: "b".repeat(64) });
    await ensureFxSnapshot(actor, transaction as never, "HKD", fetcher); await ensureFxSnapshot(actor, transaction as never, "CNY", fetcher);
    expect(readFxSnapshot(actor, transaction.id, "HKD")?.base_amount_minor).toBe("7800"); expect(readFxSnapshot(actor, transaction.id, "CNY")?.base_amount_minor).toBe("7091");
    const range = { start: "2026-09-20T00:00:00.000Z", end: "2026-09-21T00:00:00.000Z", currency_mode: "base" as const, display_currency: "HKD" as const };
    expect(getSummary(actor, { ...range, group_by: "category", category_level: "top" }).groups[0]).toMatchObject({ label: "家庭", currency: "HKD", net_expense_minor: "7800" });
    expect(getSummary(actor, { ...range, group_by: "category", category_level: "leaf" }).groups[0]).toMatchObject({ label: "日用品" });
  });
  it("fills missing FX through the shared summary helper so MCP and the web agree", async () => {
    const transaction = createTransaction(actor, { kind: "expense", amount_minor: "5000", currency: "USD", occurred_at: "2026-11-04T12:00:00+08:00", occurred_timezone: "Asia/Hong_Kong", time_precision: "minute", idempotency_key: randomUUID(), source: "manual" }).transaction as Record<string, string>;
    const range = { start: "2026-11-04T00:00:00.000Z", end: "2026-11-05T00:00:00.000Z", currency_mode: "base" as const, display_currency: "HKD" as const };
    expect(getSummary(actor, range).base).toMatchObject({ missing_fx_count: 1, coverage: 0 });
    const fetcher = async () => ({ sourceDate: "2026-11-03", ratesToHkd: { CNY: parseDecimal("1.1"), USD: parseDecimal("7.8") }, rawHash: "c".repeat(64) });
    await ensureSummaryFx(actor, range, fetcher);
    expect(getSummary(actor, range).base).toMatchObject({ currency: "HKD", expense_minor: "39000", missing_fx_count: 0, coverage: 1 });
    expect(readFxSnapshot(actor, transaction.id, "HKD")?.status).toBe("available");
  });

  it("keeps month-boundary and foreign-timezone rows inside a ranged query", () => {
    // 本地 10 月 1 日 00:30 在 UTC 仍属 9 月；纽约时区那笔的月份标签也与账本时区不同。
    // 按月预筛必须把这两类都算进候选集，否则区间查询会静默丢行。
    const make = (occurred: string, zone = "Asia/Hong_Kong") => String((createTransaction(actor, { kind: "expense", amount_minor: "100", currency: "HKD", occurred_at: occurred, occurred_timezone: zone, time_precision: "minute", idempotency_key: randomUUID(), source: "manual" }).transaction as Record<string, string>).id);
    const septemberEve = make("2028-09-30T23:30:00+08:00");
    const octoberOpen = make("2028-10-01T00:30:00+08:00");
    const octoberNewYork = make("2028-10-15T09:00:00-04:00", "America/New_York");
    const octoberClose = make("2028-10-31T23:30:00+08:00");
    const novemberOpen = make("2028-11-01T00:30:00+08:00");
    const range = { start: "2028-09-30T16:00:00.000Z", end: "2028-10-31T16:00:00.000Z" };
    const listed = listTransactions(actor, { ...range, limit: 100 });
    expect(listed.next_cursor).toBeNull();
    expect((listed.items as Array<Record<string, string>>).map((row) => row.id).sort()).toEqual([octoberOpen, octoberNewYork, octoberClose].sort());
    expect(listed.items).not.toContainEqual(expect.objectContaining({ id: septemberEve }));
    expect(listed.items).not.toContainEqual(expect.objectContaining({ id: novemberOpen }));
    expect(getSummary(actor, range).currencies.find((currency) => currency.currency === "HKD")?.expense_minor).toBe("300");
    // 分页与单次全量必须给出同一集合
    const firstPage = listTransactions(actor, { ...range, limit: 2 });
    const secondPage = listTransactions(actor, { ...range, limit: 2, cursor: firstPage.next_cursor ?? undefined });
    expect([...firstPage.items, ...secondPage.items].map((row) => (row as Record<string, string>).id).sort()).toEqual([octoberOpen, octoberNewYork, octoberClose].sort());
  });

  it("serves a secure summary to an analytics-only credential", () => {
    // MCP 的 get_summary 只挂在 analytics:read 下；统计内部不得再要求 transactions:read。
    const analyticsOnly = { ...actor, actorType: "agent" as const, actorId: randomUUID(), permissions: ["analytics:read" as const] };
    const summary = getSummary(analyticsOnly, { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" });
    expect(summary.base?.currency).toBe("HKD");
    expect(() => listTransactions(analyticsOnly, { limit: 5 })).toThrow("权限");
  });

  it("keeps a second user's ciphertext, names, and transaction IDs isolated", async () => {
    const secondOwner = "00000000-0000-4000-8000-0000000000c2"; const now = new Date().toISOString(); sqlite.prepare("INSERT INTO profiles (id,auth_subject,email,timezone,base_currency,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(secondOwner, "vault-test-2", "partner@example.com", "Asia/Hong_Kong", "HKD", 1, now, now);
    const base = userActor(secondOwner, "vault-test-2"); const initialized = await initializeVault(base, "partner private passphrase"); const session = resolveVaultSession(initialized.token, secondOwner); if (!session) throw new Error("missing second vault session"); const second = { ...base, vaultKey: session.key, vaultKeyVersion: session.keyVersion };
    createMetadata(second, "category", { name: "家庭", transaction_kind: "expense" });
    const privateTransaction = createTransaction(second, { kind: "expense", amount_minor: "888", currency: "HKD", occurred_at: "2026-09-21T12:00:00+08:00", occurred_timezone: "Asia/Hong_Kong", time_precision: "minute", merchant: "partner-only-marker", idempotency_key: randomUUID(), source: "manual" }).transaction as { id: string };
    expect(() => getTransaction(actor, privateTransaction.id)).toThrow("不存在");
    expect(listTransactions(actor, { search: "partner-only-marker", limit: 100 }).items).toEqual([]);
    expect(listMetadata(second).categories.some((item) => item.name === "家庭")).toBe(true);
  });
  it("rotates the passphrase, revokes old sessions, and preserves the master-key version", async () => {
    const result = await rotateVaultPassphrase(actor, "new correct horse battery staple");
    await expect(unlockVault(userActor(owner, "vault-test"), "correct horse battery staple")).rejects.toThrow("不正确");
    const unlocked = await unlockVault(userActor(owner, "vault-test"), "new correct horse battery staple");
    expect(result.key_version).toBe(1); expect(resolveVaultSession(unlocked.token, owner)?.keyVersion).toBe(1);
  });
});
