import { sqlite } from "@/db/client";
import { requireUnlockedUser } from "@/modules/vault/http";
import { errorResponse } from "@/modules/shared/errors";
import { listTransactions } from "@/modules/ledger/service";
import { listMetadata } from "@/modules/ledger/metadata";
import { getProfile } from "@/modules/profile/service";
import { readEncryptedEntity } from "@/modules/vault/entities";
import { readFxSnapshot } from "@/modules/fx/service";

const jsonSafe = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(jsonSafe) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)])) : value;

export async function GET(request: Request) {
  try {
    const actor = await requireUnlockedUser(request); const rows: Array<Record<string, unknown>> = []; let cursor: string | null = null;
    do { const page = listTransactions(actor, { limit: 100, cursor: cursor ?? undefined }); rows.push(...page.items as Array<Record<string, unknown>>); cursor = page.next_cursor; } while (cursor);
    const transactions = rows.map((row) => ({ ...row, fx_snapshots: ["HKD", "CNY", "USD"].map((target) => readFxSnapshot(actor, String(row.id), target)).filter(Boolean) }));
    const encryptedRows = (entityType: string) => (sqlite.prepare("SELECT entity_id FROM encrypted_entities WHERE owner_id=? AND entity_type=? ORDER BY entity_id").all(actor.ownerId, entityType) as Array<{ entity_id: string }>).map((row) => readEncryptedEntity(actor, entityType, row.entity_id));
    const payload = { schema_version: 4, exported_at: new Date().toISOString(), profile: getProfile(actor), metadata: listMetadata(actor, true), transactions, audit_events: encryptedRows("audit_event"), ai_reports: encryptedRows("ai_report") };
    return new Response(JSON.stringify(jsonSafe(payload), null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="ledger-${new Date().toISOString().slice(0,10)}.json"`, "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
