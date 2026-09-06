import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { assertAllowedEmail } from "@/modules/identity/access";
import { createSupabaseServerClient } from "@/modules/identity/supabase";

const allowedTypes = new Set<EmailOtpType>(["email", "invite", "magiclink", "recovery", "signup"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const requestedNext = url.searchParams.get("next") ?? (type === "invite" || type === "signup" ? "/onboarding" : "/");
  const next = requestedNext.startsWith("/") && !requestedNext.startsWith("//") ? requestedNext : "/";
  if (!tokenHash || !type || !allowedTypes.has(type)) return NextResponse.redirect(new URL("/login?error=invalid_invite", url));
  const supabase = await createSupabaseServerClient();
  const result = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (result.error || !result.data.user?.email) return NextResponse.redirect(new URL("/login?error=invalid_invite", url));
  try {
    assertAllowedEmail(result.data.user.email);
  } catch {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login?error=not_allowed", url));
  }
  return NextResponse.redirect(new URL(next, url));
}
