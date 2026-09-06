export type ErrorCode = "VALIDATION_ERROR" | "UNAUTHENTICATED" | "AUTH_REQUIRED" | "USER_NOT_ALLOWED" | "USER_DISABLED" | "VAULT_LOCKED" | "FORBIDDEN" | "NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "VERSION_CONFLICT" | "RATE_LIMITED" | "QUOTA_EXCEEDED" | "MIGRATION_NOT_READY" | "CONFLICT" | "FX_UNAVAILABLE" | "AI_NOT_CONFIGURED" | "AI_ERROR" | "AI_PROVIDER_FAILED";

export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public status = 400, public details?: unknown) {
    super(message);
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof AppError) return Response.json({ error: { code: error.code, message: error.message, details: error.details } }, { status: error.status });
  console.error(error instanceof Error ? error.message : "Unknown server error");
  return Response.json({ error: { code: "INTERNAL_ERROR", message: "服务器暂时无法处理请求" } }, { status: 500 });
}
