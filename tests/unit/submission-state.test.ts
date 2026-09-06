import { describe, expect, it, vi } from "vitest";
import { resolveSubmission } from "@/modules/ledger/submission-state";

describe("entry submission state", () => {
  it("invalidates the key immediately after a confirmed save", () => {
    const nextKey = vi.fn(() => "next-key");
    expect(resolveSubmission("used-key", "confirmed", false, nextKey)).toEqual({ phase: "saved", idempotencyKey: "next-key" });
    expect(nextKey).toHaveBeenCalledOnce();
  });

  it("starts a fresh draft after confirmed save-and-continue", () => {
    expect(resolveSubmission("used-key", "confirmed", true, () => "fresh-key")).toEqual({ phase: "draft", idempotencyKey: "fresh-key" });
  });

  it("preserves the key for both a known rejection and an uncertain result", () => {
    expect(resolveSubmission("retry-key", "rejected", false, () => "unused")).toEqual({ phase: "draft", idempotencyKey: "retry-key" });
    expect(resolveSubmission("retry-key", "uncertain", false, () => "unused")).toEqual({ phase: "uncertain", idempotencyKey: "retry-key" });
  });
});
