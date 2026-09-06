import { requireUnlockedUser } from "@/modules/vault/http";
import { getAiPreferences, updateAiPreferences } from "@/modules/ai/preferences";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin } from "@/modules/shared/security";

export async function GET(request: Request) { try { return Response.json(getAiPreferences(await requireUnlockedUser(request)), { headers: { "cache-control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function PATCH(request: Request) { try { assertSameOrigin(request); return Response.json(updateAiPreferences(await requireUnlockedUser(request), await request.json())); } catch (error) { return errorResponse(error); } }
