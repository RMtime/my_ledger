export type SubmissionPhase = "draft" | "uncertain" | "saved";

export function resolveSubmission(
  idempotencyKey: string,
  outcome: "confirmed" | "rejected" | "uncertain",
  continueAfter: boolean,
  nextKey: () => string,
): { phase: SubmissionPhase; idempotencyKey: string } {
  if (outcome === "confirmed") {
    return { phase: continueAfter ? "draft" : "saved", idempotencyKey: nextKey() };
  }
  return { phase: outcome === "rejected" ? "draft" : "uncertain", idempotencyKey };
}
