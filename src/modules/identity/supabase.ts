import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { sqlite } from "@/db/client";
import { AppError } from "@/modules/shared/errors";
import { userActor, type ActorContext } from "./types";
import { randomUUID } from "node:crypto";

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
    return userActor(ownerId, requestId);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new AppError("UNAUTHENTICATED", "登录服务尚未配置", 401);
  const store = await cookies();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (items) => { for (const item of items) store.set(item.name, item.value, item.options); },
    },
  });
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user?.email) throw new AppError("UNAUTHENTICATED", "登录已过期，请重新登录", 401);
  const allowed = process.env.ALLOWED_AUTH_EMAIL?.trim().toLowerCase();
  if (!allowed || user.email.toLowerCase() !== allowed) throw new AppError("FORBIDDEN", "此账户不在允许名单中", 403);
  const existing = sqlite.prepare("SELECT id, enabled FROM profiles WHERE auth_subject = ?").get(user.id) as { id: string; enabled: number } | undefined;
  if (existing && !existing.enabled) throw new AppError("FORBIDDEN", "账户已停用", 403);
  const ownerId = existing?.id ?? randomUUID();
  if (!existing) {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO profiles (id,auth_subject,email,timezone,base_currency,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(ownerId, user.id, user.email, process.env.APP_TIMEZONE ?? "Asia/Hong_Kong", process.env.APP_BASE_CURRENCY ?? "HKD", 1, now, now);
  }
  return userActor(ownerId, requestId);
}
