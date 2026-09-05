import { AppError } from "./errors";

const buckets = new Map<string, { count: number; resetAt: number }>();

export function assertSameOrigin(request: Request) {
  const configured = new URL(process.env.APP_ORIGIN ?? "http://localhost:3000");
  const origin = request.headers.get("origin");
  if (origin && origin !== configured.origin) throw new AppError("FORBIDDEN", "跨站写请求已拒绝", 403);
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/json")) throw new AppError("VALIDATION_ERROR", "写请求必须使用 application/json", 415);
}

export function rateLimit(key: string, limit: number, windowMs: number) {
  const timestamp = Date.now(); const current = buckets.get(key);
  if (!current || current.resetAt <= timestamp) { buckets.set(key, { count: 1, resetAt: timestamp + windowMs }); return; }
  current.count += 1;
  if (current.count > limit) throw new AppError("RATE_LIMITED", "请求过于频繁，请稍后再试", 429);
}
