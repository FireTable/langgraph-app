import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const KEK_LENGTH_BYTES = 32;
export const IV_LENGTH_BYTES = 12;
export const AUTH_TAG_LENGTH_BYTES = 16;

export class KekMissingError extends Error {
  constructor() {
    super("LLM_KEY_ENCRYPTION_KEY is missing or malformed (need 64 hex chars = 32 bytes)");
    this.name = "KekMissingError";
  }
}

/**
 * Resolve the KEK from process.env.LLM_KEY_ENCRYPTION_KEY.
 * Throws KekMissingError if missing, wrong length, or non-hex.
 * Caller should call this lazily (per-operation) so KEK rotation
 * takes effect without restart — we don't module-scope the buffer.
 */
export function loadKek(): Buffer {
  const hex = process.env.LLM_KEY_ENCRYPTION_KEY;
  if (!hex || hex.length !== KEK_LENGTH_BYTES * 2) throw new KekMissingError();
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new KekMissingError();
  return Buffer.from(hex, "hex");
}

export type EncryptedBlob = { encryptedKey: string; iv: string };

export function aesGcmEncrypt(plaintext: string, kek: Buffer): EncryptedBlob {
  if (kek.length !== KEK_LENGTH_BYTES) {
    throw new Error(`KEK must be ${KEK_LENGTH_BYTES} bytes, got ${kek.length}`);
  }
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // ponytail: pack ciphertext + authTag into one base64 blob so callers
  // only juggle two fields (blob + iv) instead of three.
  return {
    encryptedKey: Buffer.concat([ciphertext, authTag]).toString("base64"),
    iv: iv.toString("base64"),
  };
}

export function aesGcmDecrypt(encrypted: string, ivB64: string, kek: Buffer): string {
  if (kek.length !== KEK_LENGTH_BYTES) {
    throw new Error(`KEK must be ${KEK_LENGTH_BYTES} bytes, got ${kek.length}`);
  }
  const buf = Buffer.from(encrypted, "base64");
  if (buf.length < AUTH_TAG_LENGTH_BYTES) {
    throw new Error("ciphertext too short — auth tag missing");
  }
  const authTag = buf.subarray(buf.length - AUTH_TAG_LENGTH_BYTES);
  const ciphertext = buf.subarray(0, buf.length - AUTH_TAG_LENGTH_BYTES);
  const iv = Buffer.from(ivB64, "base64");
  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error(`iv must be ${IV_LENGTH_BYTES} bytes, got ${iv.length}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", kek, iv);
  decipher.setAuthTag(authTag);
  // ponytail: GCM auth tag mismatch throws — that's the tamper detection.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Convenience: auto-derive the last-4-chars "name" used to identify a key
 * in admin UI lists. Caller is responsible for never storing the full
 * plaintext beyond this function's return.
 */
export function deriveKeyName(plaintext: string): string {
  return `...${plaintext.slice(-4)}`;
}
