import { describe, it, expect, beforeEach } from "vitest";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveKeyName,
  KekMissingError,
  loadKek,
} from "@/lib/auth/encryption";

const VALID_KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("AES-256-GCM encryption", () => {
  beforeEach(() => {
    process.env.LLM_KEY_ENCRYPTION_KEY = VALID_KEK;
  });

  it("round-trips plaintext", () => {
    const kek = loadKek();
    const { encryptedKey, iv } = aesGcmEncrypt("sk-proj-abc123xyz9", kek);
    const decrypted = aesGcmDecrypt(encryptedKey, iv, kek);
    expect(decrypted).toBe("sk-proj-abc123xyz9");
  });

  it("produces different ciphertext for same plaintext (random IV)", () => {
    const kek = loadKek();
    const a = aesGcmEncrypt("sk-same-plaintext", kek);
    const b = aesGcmEncrypt("sk-same-plaintext", kek);
    expect(a.encryptedKey).not.toBe(b.encryptedKey);
    expect(a.iv).not.toBe(b.iv);
  });

  it("tampered ciphertext fails (GCM auth tag)", () => {
    const kek = loadKek();
    const { encryptedKey, iv } = aesGcmEncrypt("sk-original", kek);
    const buf = Buffer.from(encryptedKey, "base64");
    buf[0] = buf[0] ^ 0xff;
    const tampered = buf.toString("base64");
    expect(() => aesGcmDecrypt(tampered, iv, kek)).toThrow();
  });

  it("wrong KEK fails to decrypt", () => {
    const kekA = loadKek();
    const { encryptedKey, iv } = aesGcmEncrypt("sk-secret", kekA);
    const kekB = Buffer.from(
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      "hex",
    );
    expect(() => aesGcmDecrypt(encryptedKey, iv, kekB)).toThrow();
  });

  it("rejects too-short ciphertext", () => {
    const kek = loadKek();
    expect(() =>
      aesGcmDecrypt(Buffer.from("aGVsbG8=", "base64").toString("base64"), "AAAA", kek),
    ).toThrow(/auth tag/i);
  });

  it("deriveKeyName returns first 3 + … + last 4", () => {
    expect(deriveKeyName("sk-proj-abc123xyz9")).toBe("sk-…xyz9");
    expect(deriveKeyName("ab")).toBe("ab…ab");
  });
});

describe("loadKek validation", () => {
  it("throws KekMissingError when env is unset", () => {
    delete process.env.LLM_KEY_ENCRYPTION_KEY;
    expect(() => loadKek()).toThrow(KekMissingError);
  });

  it("throws KekMissingError when env is wrong length", () => {
    process.env.LLM_KEY_ENCRYPTION_KEY = "abcd";
    expect(() => loadKek()).toThrow(KekMissingError);
  });

  it("throws KekMissingError when env is non-hex", () => {
    process.env.LLM_KEY_ENCRYPTION_KEY = "z".repeat(64);
    expect(() => loadKek()).toThrow(KekMissingError);
  });
});
