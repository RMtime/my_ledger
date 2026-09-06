import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scrypt } from "node:crypto";

export const vaultKdf = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
export type CipherEnvelope = { v: 1; nonce: string; ciphertext: string; tag: string };

export function derivePassphraseKey(passphrase: string, salt: Buffer, parameters: { N: number; r: number; p: number; maxmem: number } = vaultKdf) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(passphrase, salt, 32, parameters, (error, key) => error ? reject(error) : resolve(key));
  });
}

export function deriveRecoveryKey(recoveryKey: Buffer, ownerId: string) {
  return Buffer.from(hkdfSync("sha256", recoveryKey, Buffer.from(ownerId), Buffer.from("my-ledger:vault-recovery:v1"), 32));
}

function deriveEntityKey(masterKey: Buffer, ownerId: string, purpose: string) {
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.from(ownerId), Buffer.from(`my-ledger:${purpose}:v1`), 32));
}

export function encryptBytes(key: Buffer, plaintext: Buffer, aad: string): CipherEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { v: 1, nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}

export function decryptBytes(key: Buffer, envelope: CipherEnvelope, aad: string) {
  if (envelope.v !== 1) throw new Error("Unsupported encrypted payload version");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
}

export function wrapMasterKey(kek: Buffer, masterKey: Buffer, ownerId: string, keyVersion: number, purpose: "passphrase" | "recovery") {
  return encryptBytes(kek, masterKey, `vault|${ownerId}|${keyVersion}|${purpose}`);
}

export function unwrapMasterKey(kek: Buffer, envelope: CipherEnvelope, ownerId: string, keyVersion: number, purpose: "passphrase" | "recovery") {
  return decryptBytes(kek, envelope, `vault|${ownerId}|${keyVersion}|${purpose}`);
}

export function encryptEntity(masterKey: Buffer, ownerId: string, entityType: string, entityId: string, keyVersion: number, value: unknown) {
  const key = deriveEntityKey(masterKey, ownerId, `entity:${entityType}`);
  try { return encryptBytes(key, Buffer.from(JSON.stringify(value)), `${ownerId}|${entityType}|${entityId}|${keyVersion}`); }
  finally { key.fill(0); }
}

export function decryptEntity<T>(masterKey: Buffer, ownerId: string, entityType: string, entityId: string, keyVersion: number, envelope: CipherEnvelope): T {
  const key = deriveEntityKey(masterKey, ownerId, `entity:${entityType}`);
  try { return JSON.parse(decryptBytes(key, envelope, `${ownerId}|${entityType}|${entityId}|${keyVersion}`).toString("utf8")) as T; }
  finally { key.fill(0); }
}

export function blindIndex(masterKey: Buffer, ownerId: string, domain: string, value: string) {
  const key = deriveEntityKey(masterKey, ownerId, `blind:${domain}`);
  try { return createHmac("sha256", key).update(value.normalize("NFKC").trim().toLowerCase()).digest("hex"); }
  finally { key.fill(0); }
}
