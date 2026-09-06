import { createSupabaseServerClient } from "@/modules/identity/supabase";
import { assertSameOrigin } from "@/modules/shared/security";
import { clearVaultCookie } from "@/modules/vault/http";
import { revokeOwnerVaultSessions } from "@/modules/vault/session";
import { revokeOwnerAgentVaultGrants } from "@/modules/vault/agent-session";
import { requireUser } from "@/modules/identity/supabase";

export async function POST(request: Request) { assertSameOrigin(request); const actor = await requireUser(request); revokeOwnerVaultSessions(actor.ownerId); revokeOwnerAgentVaultGrants(actor.ownerId); await clearVaultCookie(); if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) await (await createSupabaseServerClient()).auth.signOut(); return Response.json({ ok: true }); }
