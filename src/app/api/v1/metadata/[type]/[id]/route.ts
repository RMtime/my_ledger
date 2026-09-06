import { requireUnlockedUser } from "@/modules/vault/http";
import { updateMetadata, parseMetadataType } from "@/modules/ledger/metadata";
import { AppError, errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin } from "@/modules/shared/security";

type Params = { params: Promise<{ type: string; id: string }> };
export async function PATCH(request: Request, { params }: Params) {
  try {
    assertSameOrigin(request);
    const values = await params;
    const type = parseMetadataType(values.type);
    if (!type) throw new AppError("NOT_FOUND", "元数据类型不存在", 404);
    return Response.json(updateMetadata(await requireUnlockedUser(request), type, values.id, await request.json()));
  } catch (error) { return errorResponse(error); }
}
