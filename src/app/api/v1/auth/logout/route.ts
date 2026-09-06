import { createSupabaseServerClient } from "@/modules/identity/supabase";
import { assertSameOrigin } from "@/modules/shared/security";

export async function POST(request: Request) { assertSameOrigin(request); if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) await (await createSupabaseServerClient()).auth.signOut(); return Response.json({ ok: true }); }
