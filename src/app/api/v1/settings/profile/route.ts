import { requireUnlockedUser } from "@/modules/vault/http";
import { getProfile, updateProfile } from "@/modules/profile/service";
import { errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin } from "@/modules/shared/security";

export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { return Response.json(getProfile(await requireUnlockedUser(request)), { headers: { "cache-control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function PATCH(request: Request) { try { assertSameOrigin(request); return Response.json(updateProfile(await requireUnlockedUser(request), await request.json())); } catch (error) { return errorResponse(error); } }
