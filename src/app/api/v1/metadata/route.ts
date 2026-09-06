import { requireUnlockedUser } from "@/modules/vault/http";
import { createMetadata, listMetadata, parseMetadataType } from "@/modules/ledger/metadata";
import { AppError, errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin } from "@/modules/shared/security";

export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { return Response.json(listMetadata(await requireUnlockedUser(request)), { headers: { "cache-control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUnlockedUser(request); const body = await request.json(); const type = parseMetadataType(String(body.type ?? "")); if (!type) throw new AppError("VALIDATION_ERROR", "元数据类型不正确", 422); return Response.json(createMetadata(actor, type, body), { status: 201 }); } catch (error) { return errorResponse(error); } }
