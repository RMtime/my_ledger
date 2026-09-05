import { requireUser } from "@/modules/identity/supabase";
import { listMetadata } from "@/modules/ledger/metadata";
import { listTransactions } from "@/modules/ledger/service";
import { errorResponse } from "@/modules/shared/errors";
import { sqlite } from "@/db/client";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const actor = await requireUser(request);
    const profile = sqlite.prepare("SELECT timezone,base_currency,email FROM profiles WHERE id=?").get(actor.ownerId);
    return Response.json({ profile, metadata: listMetadata(actor), recent: listTransactions(actor, { limit: 20 }), ai_configured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL) }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
