import { requireUnlockedUser } from "@/modules/vault/http";
import { extractCandidate } from "@/modules/ai/provider";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin, rateLimit } from "@/modules/shared/security";

export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUnlockedUser(request); rateLimit(`ai:${actor.ownerId}`, 20, 60_000); const body = await request.json(); return Response.json(await extractCandidate(actor, String(body.text ?? ""), new Date().toISOString(), String(body.timezone ?? "Asia/Hong_Kong"))); } catch (error) { return errorResponse(error); } }
