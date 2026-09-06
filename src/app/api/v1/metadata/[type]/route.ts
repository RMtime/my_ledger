import { requireUnlockedUser } from "@/modules/vault/http";
import { listMetadata, parseMetadataType } from "@/modules/ledger/metadata";
import { AppError, errorResponse } from "@/modules/shared/errors";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ type: string }> };
export async function GET(request: Request, { params }: Params) {
  try {
    const type = parseMetadataType((await params).type);
    if (!type) throw new AppError("NOT_FOUND", "元数据类型不存在", 404);
    const data = listMetadata(await requireUnlockedUser(request));
    const key = type === "payment_method" ? "payment_methods" : `${type}s`;
    return Response.json({ items: data[key as keyof typeof data] }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
