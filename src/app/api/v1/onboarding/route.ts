import { createSupabaseServerClient, requireUser } from "@/modules/identity/supabase";
import { AppError, errorResponse } from "@/modules/shared/errors";
import { assertSameOrigin } from "@/modules/shared/security";
import { z } from "zod";

const onboardingSchema = z.object({ password: z.string().min(12).max(128) });

export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { const actor = await requireUser(request); return Response.json({ ready: true, owner_id: actor.ownerId }, { headers: { "cache-control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) { try { assertSameOrigin(request); const actor = await requireUser(request); const parsed = onboardingSchema.safeParse(await request.json()); if (!parsed.success) throw new AppError("VALIDATION_ERROR", "密码至少需要 12 个字符", 422); const result = await (await createSupabaseServerClient()).auth.updateUser({ password: parsed.data.password }); if (result.error) throw new AppError("CONFLICT", "密码设置失败，请重新打开邀请链接", 409); return Response.json({ ready: true, owner_id: actor.ownerId }, { headers: { "cache-control": "no-store" } }); } catch (error) { return errorResponse(error); } }
