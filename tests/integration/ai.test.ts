import { beforeAll, describe, expect, it, vi } from "vitest";
import { sqlite } from "@/db/client";
import { userActor, type ActorContext } from "@/modules/identity/types";
import { initializeVault } from "@/modules/vault/service";
import { resolveVaultSession } from "@/modules/vault/session";
import { updateAiPreferences } from "@/modules/ai/preferences";

const owner = "00000000-0000-4000-8000-0000000000d1";
let actor: ActorContext;
let extractCandidate: typeof import("@/modules/ai/provider").extractCandidate;

beforeAll(async () => {
  process.env.DEEPSEEK_API_KEY = "synthetic-test-key"; process.env.DEEPSEEK_MODEL = "synthetic-model"; process.env.AI_USER_CONCURRENCY = "1"; process.env.AI_GLOBAL_CONCURRENCY = "4"; process.env.AI_DAILY_ATTEMPT_LIMIT = "20"; process.env.AI_DAILY_SUCCESS_LIMIT = "10";
  const now = new Date().toISOString(); sqlite.prepare("INSERT INTO profiles (id,auth_subject,email,timezone,base_currency,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(owner, "ai-test", "ai@example.com", "Asia/Hong_Kong", "HKD", 1, now, now);
  const base = userActor(owner, "ai-test"); const initialized = await initializeVault(base, "correct horse battery staple"); const session = resolveVaultSession(initialized.token, owner); if (!session) throw new Error("missing vault session"); actor = { ...base, vaultKey: session.key, vaultKeyVersion: session.keyVersion };
  updateAiPreferences(actor, { enabled: true, provider: "deepseek", consent_version: "test-v1" });
  ({ extractCandidate } = await import("@/modules/ai/provider"));
});

const candidate = { kind: "expense", amount_minor: "3800", currency: "HKD", occurred_at: "2026-09-06T12:00:00+08:00", occurred_timezone: "Asia/Hong_Kong", time_precision: "minute", merchant: "synthetic", note: null, payment_method: "cash", confidence: 0.9 };
const response = () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(candidate) } }], usage: { prompt_tokens: 12, completion_tokens: 8 } }), { status: 200, headers: { "content-type": "application/json" } });

describe("AI quota reservation", () => {
  it("reserves before network, enforces user concurrency, and reuses encrypted success", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls += 1; await gate; return response(); }));
    const first = extractCandidate(actor, "synthetic first", "2026-09-06T12:00:00+08:00", "Asia/Hong_Kong");
    await vi.waitFor(() => expect(calls).toBe(1));
    await expect(extractCandidate(actor, "synthetic second", "2026-09-06T12:00:00+08:00", "Asia/Hong_Kong")).rejects.toThrow("并发已满");
    release(); await expect(first).resolves.toMatchObject({ candidate, cached: false });
    await expect(extractCandidate(actor, "synthetic first", "2026-09-06T12:00:00+08:00", "Asia/Hong_Kong")).resolves.toMatchObject({ candidate, cached: true });
    expect(calls).toBe(1);
    const invocation = sqlite.prepare("SELECT status,input_tokens,output_tokens FROM ai_invocations WHERE owner_id=? AND status='succeeded'").get(owner);
    expect(invocation).toEqual({ status: "succeeded", input_tokens: 12n, output_tokens: 8n });
    vi.unstubAllGlobals();
  });

  it.each([
    ["empty", { finish_reason: "stop", message: { content: "" } }],
    ["truncated", { finish_reason: "length", message: { content: '{"kind":"expense"' } }],
  ])("disables DeepSeek thinking and retries a %s structured response", async (label, firstChoice) => {
    const requests: Array<Record<string, unknown>> = []; let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1; requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (calls === 1) return new Response(JSON.stringify({ choices: [firstChoice], usage: { prompt_tokens: 10, completion_tokens: 2048 } }), { status: 200, headers: { "content-type": "application/json" } });
      return response();
    }));
    await expect(extractCandidate(actor, `synthetic retry ${label}`, "2026-09-06T12:00:00+08:00", "Asia/Hong_Kong")).resolves.toMatchObject({ candidate, cached: false });
    expect(calls).toBe(2);
    expect(requests[0]).toMatchObject({ thinking: { type: "disabled" }, max_tokens: 2048, response_format: { type: "json_object" } });
    expect(requests[1]).toMatchObject({ thinking: { type: "disabled" }, max_tokens: 4096, response_format: { type: "json_object" } });
    expect(sqlite.prepare("SELECT attempts,input_tokens,output_tokens FROM ai_invocations WHERE owner_id=? ORDER BY rowid DESC LIMIT 1").get(owner)).toEqual({ attempts: 1n, input_tokens: 22n, output_tokens: 2056n });
    vi.unstubAllGlobals();
  });
});
