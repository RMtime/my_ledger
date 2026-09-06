import { errorResponse, AppError } from "@/modules/shared/errors";
import { assertSameOrigin, rateLimit } from "@/modules/shared/security";
import { assertAllowedEmail, normalizeEmail } from "@/modules/identity/access";
import { createSupabaseServerClient } from "@/modules/identity/supabase";
import { z } from "zod";

const loginSchema = z.object({ email: z.email().transform(normalizeEmail), password: z.string().min(1).max(1024) });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request); rateLimit(`login:${request.headers.get("x-forwarded-for") ?? "unknown"}`, 8, 60_000);
    const parsed = loginSchema.safeParse(await request.json());
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "邮箱或密码格式不正确", 422);
    assertAllowedEmail(parsed.data.email);
    const supabase = await createSupabaseServerClient();
    const { email, password } = parsed.data;
    const result = await supabase.auth.signInWithPassword({ email, password });
    if (result.error || !result.data.user?.email) throw new AppError("AUTH_REQUIRED", "邮箱或密码不正确", 401);
    try { assertAllowedEmail(result.data.user.email); } catch (error) { await supabase.auth.signOut(); throw error; }
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
