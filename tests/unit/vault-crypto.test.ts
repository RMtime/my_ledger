import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { blindIndex, decryptBytes, encryptBytes } from "@/modules/vault/crypto";

describe("vault cryptography", () => {
  it("rejects AAD and ciphertext tampering", () => {
    const key = randomBytes(32); const envelope = encryptBytes(key, Buffer.from("secret"), "owner|transaction|id|1");
    expect(decryptBytes(key, envelope, "owner|transaction|id|1").toString()).toBe("secret");
    expect(() => decryptBytes(key, envelope, "other-owner|transaction|id|1")).toThrow();
    const tampered = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}`;
    expect(() => decryptBytes(key, { ...envelope, ciphertext: tampered }, "owner|transaction|id|1")).toThrow();
    key.fill(0);
  });

  it("creates deterministic, owner-scoped blind indexes", () => {
    const key = randomBytes(32);
    expect(blindIndex(key, "owner-a", "name", "  Coffee ")).toBe(blindIndex(key, "owner-a", "name", "coffee"));
    expect(blindIndex(key, "owner-a", "name", "coffee")).not.toBe(blindIndex(key, "owner-b", "name", "coffee"));
    key.fill(0);
  });
});
