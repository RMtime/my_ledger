import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function POST() { const store = await cookies(); const url = process.env.NEXT_PUBLIC_SUPABASE_URL!; const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!; if (url && key) { const supabase = createServerClient(url, key, { cookies: { getAll: () => store.getAll(), setAll: (items) => items.forEach((item) => store.set(item.name, item.value, item.options)) } }); await supabase.auth.signOut(); } return Response.json({ ok: true }); }
