import { describe, expect, it } from "vitest";
import { assertAllowedEmail, configuredAllowedEmails, normalizeEmail } from "@/modules/identity/access";

describe("authentication allowlist", () => {
  it("normalizes comma-separated addresses and accepts either invited user", () => {
    const env = { ALLOWED_AUTH_EMAILS: " User@Example.com, partner@example.com , " };
    expect(configuredAllowedEmails(env)).toEqual(new Set(["user@example.com", "partner@example.com"]));
    expect(assertAllowedEmail(" PARTNER@example.com ", env)).toBe("partner@example.com");
    expect(normalizeEmail(" User@Example.COM ")).toBe("user@example.com");
  });

  it("fails closed and gives the plural setting precedence", () => {
    expect(() => assertAllowedEmail("user@example.com", {})).toThrow("允许名单");
    const env = { ALLOWED_AUTH_EMAILS: "", ALLOWED_AUTH_EMAIL: "user@example.com" };
    expect(() => assertAllowedEmail("user@example.com", env)).toThrow("允许名单");
  });

  it("supports the singular setting only as a compatibility fallback", () => {
    const env = { ALLOWED_AUTH_EMAIL: "legacy@example.com" };
    expect(assertAllowedEmail("legacy@example.com", env)).toBe("legacy@example.com");
  });
});
