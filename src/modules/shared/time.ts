import { DateTime } from "luxon";

const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function normalizeUtcInstant(value: string): string | null {
  if (!isoInstantPattern.test(value)) return null;
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) return null;
  return new Date(parsed.toMillis()).toISOString();
}
