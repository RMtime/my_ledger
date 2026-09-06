import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { sqlite } from "@/db/client";
import { AppError } from "@/modules/shared/errors";
import { userActor, type ActorContext } from "./types";
import { randomUUID } from "node:crypto";
import { assertAllowedEmail } from "./access";

export async function createSupabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new AppError("AUTH_REQUIRED", "登录服务尚未配置", 503);
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (items) => { for (const item of items) store.set(item.name, item.value, item.options); },
    },
  });
}

function ensureLocalProfile(ownerId: string) {
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT OR IGNORE INTO profiles (id,auth_subject,email,timezone,base_currency,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(ownerId, `local:${ownerId}`, "local@example.invalid", process.env.APP_TIMEZONE ?? "Asia/Hong_Kong", process.env.APP_BASE_CURRENCY ?? "HKD", 1, now, now);
}

export async function requireUser(request?: Request): Promise<ActorContext> {
  const requestId = request?.headers.get("x-request-id") ?? randomUUID();
  if (process.env.LOCAL_DEV_AUTH === "true" && process.env.NODE_ENV !== "production") {
    const ownerId = process.env.LOCAL_DEV_OWNER_ID ?? "00000000-0000-4000-8000-000000000001";
    ensureLocalProfile(ownerId);
    const profile = sqlite.prepare("SELECT enabled FROM profiles WHERE id=?").get(ownerId) as { enabled: number } | undefined;
    if (!profile?.enabled) throw new AppError("USER_DISABLED", "账户已停用", 403);
    return userActor(ownerId, requestId);
  }
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user?.email) throw new AppError("AUTH_REQUIRED", "登录已过期，请重新登录", 401);
  const normalizedEmail = assertAllowedEmail(user.email);
  const existing = sqlite.prepare("SELECT id, enabled FROM profiles WHERE auth_subject = ?").get(user.id) as { id: string; enabled: number } | undefined;
  if (existing && !existing.enabled) throw new AppError("USER_DISABLED", "账户已停用", 403);
  const ownerId = existing?.id ?? randomUUID();
  if (!existing) {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO profiles (id,auth_subject,email,timezone,base_currency,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(ownerId, user.id, normalizedEmail, process.env.APP_TIMEZONE ?? "Asia/Hong_Kong", process.env.APP_BASE_CURRENCY ?? "HKD", 1, now, now);
  } else {
    sqlite.prepare("UPDATE profiles SET email=?,updated_at=? WHERE id=? AND email<>?").run(normalizedEmail, new Date().toISOString(), ownerId, normalizedEmail);
  }
  return userActor(ownerId, requestId);
}
