import { AppError } from "@/modules/shared/errors";

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function configuredAllowedEmails(env: Record<string, string | undefined> = process.env) {
  const source = env.ALLOWED_AUTH_EMAILS !== undefined ? env.ALLOWED_AUTH_EMAILS : env.ALLOWED_AUTH_EMAIL;
  return new Set((source ?? "").split(",").map(normalizeEmail).filter(Boolean));
}

export function assertAllowedEmail(email: string, env: Record<string, string | undefined> = process.env) {
  const normalized = normalizeEmail(email);
  if (!normalized || !configuredAllowedEmails(env).has(normalized)) {
    throw new AppError("USER_NOT_ALLOWED", "此账户不在允许名单中", 403);
  }
  return normalized;
}
