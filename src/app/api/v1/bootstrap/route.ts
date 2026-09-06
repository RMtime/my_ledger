import { requireUser } from "@/modules/identity/supabase";
import { listMetadata } from "@/modules/ledger/metadata";
import { listTransactions } from "@/modules/ledger/service";
import { errorResponse } from "@/modules/shared/errors";
import { sqlite } from "@/db/client";
import { attachVaultSession } from "@/modules/vault/http";
import { getVaultStatus } from "@/modules/vault/service";
import { readEncryptedEntity } from "@/modules/vault/entities";
import { getAiPreferences } from "@/modules/ai/preferences";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const actor = await requireUser(request); const vault = getVaultStatus(actor.ownerId);
    if (!vault.initialized) return Response.json({ profile: { email: (sqlite.prepare("SELECT email FROM profiles WHERE id=?").get(actor.ownerId) as { email: string } | undefined)?.email }, vault: { state: "setup_required" } }, { headers: { "cache-control": "no-store" } });
    const unlocked = await attachVaultSession(actor);
    if (!unlocked.vaultKey) return Response.json({ profile: { email: (sqlite.prepare("SELECT email FROM profiles WHERE id=?").get(actor.ownerId) as { email: string } | undefined)?.email }, vault: { state: "locked", key_version: vault.key_version } }, { headers: { "cache-control": "no-store" } });
    const profile = readEncryptedEntity<Record<string, unknown>>(unlocked, "profile", actor.ownerId) ?? sqlite.prepare("SELECT timezone,base_currency,email FROM profiles WHERE id=?").get(actor.ownerId);
    const ai = getAiPreferences(unlocked); const providerReady = ai.provider === "deepseek" ? Boolean(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_MODEL) : ai.provider === "minimax" ? Boolean(process.env.MINIMAX_API_KEY && process.env.MINIMAX_MODEL) : false;
    return Response.json({ profile, vault: { state: "unlocked", key_version: vault.key_version }, metadata: listMetadata(unlocked), recent: listTransactions(unlocked, { limit: 20 }), ai_configured: ai.enabled && providerReady }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
