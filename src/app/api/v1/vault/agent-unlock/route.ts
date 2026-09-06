import { sqlite } from "@/db/client";
import { requireUnlockedUser } from "@/modules/vault/http";
import { grantAgentVault, revokeAgentVaultGrant } from "@/modules/vault/agent-session";
import { AppError, errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin } from "@/modules/shared/security";

function ownedActiveCredential(ownerId: string, id: string) {
  return sqlite.prepare("SELECT id FROM agent_credentials WHERE owner_id=? AND id=? AND revoked_at IS NULL AND expires_at>?").get(ownerId, id, new Date().toISOString()) as { id: string } | undefined;
}

export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUnlockedUser(request); const body = await request.json(); const id = String(body.credential_id ?? ""); const minutes = Number(body.minutes ?? 30); if (!ownedActiveCredential(actor.ownerId, id)) throw new AppError("NOT_FOUND", "Agent 凭证不存在或已经失效", 404); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) throw new AppError("VALIDATION_ERROR", "临时解锁必须为 1–30 分钟", 422); return Response.json(grantAgentVault(actor, id, minutes)); } catch (error) { return errorResponse(error); } }
export async function DELETE(request: Request) { try { assertSameOrigin(request); const actor = await requireUnlockedUser(request); const body = await request.json(); const id = String(body.credential_id ?? ""); if (!sqlite.prepare("SELECT 1 FROM agent_credentials WHERE owner_id=? AND id=?").get(actor.ownerId, id)) throw new AppError("NOT_FOUND", "Agent 凭证不存在", 404); revokeAgentVaultGrant(id); return Response.json({ revoked: true }); } catch (error) { return errorResponse(error); } }
