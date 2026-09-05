import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { errorResponse, AppError } from "@/modules/shared/errors";
import { assertSameOrigin, rateLimit } from "@/modules/shared/security";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request); rateLimit(`login:${request.headers.get("x-forwarded-for") ?? "unknown"}`, 8, 60_000);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new AppError("UNAUTHENTICATED", "登录服务尚未配置", 503);
    const { email, password } = await request.json(); const store = await cookies();
    const supabase = createServerClient(url, key, { cookies: { getAll: () => store.getAll(), setAll: (items) => items.forEach((item) => store.set(item.name, item.value, item.options)) } });
    const result = await supabase.auth.signInWithPassword({ email, password });
    if (result.error) throw new AppError("UNAUTHENTICATED", "邮箱或密码不正确", 401);
    if (email.toLowerCase() !== process.env.ALLOWED_AUTH_EMAIL?.toLowerCase()) { await supabase.auth.signOut(); throw new AppError("FORBIDDEN", "此账户不在允许名单中", 403); }
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
