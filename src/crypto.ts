import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";

/**
 * Client-side payload protection, wire-compatible with dataflow-go/encoder:
 * AES-256-GCM over the JSON payload, key derived from the user secret via
 * PBKDF2-SHA256 (10 000 iterations, 32-byte key, 16-byte salt, 96-bit IV).
 * The secret never leaves the host process; servers and dashboards only
 * ever see ciphertext plus the salt needed to re-derive the key.
 */

export const KEY_LEN = 32;
export const IV_LEN = 12;
export const SALT_LEN = 16;
export const ITERATIONS = 10000;

/** Stretches secret with salt into an AES-256 key (PBKDF2-HMAC-SHA256). */
export function deriveKey(secret: string, salt: Buffer): Buffer {
  if (!secret) throw new Error("dataflow: empty encryption secret");
  return pbkdf2Sync(secret, salt, ITERATIONS, KEY_LEN, "sha256");
}

/** Decodes a hex salt, or generates a fresh random 16-byte one when empty. */
export function saltFromHex(raw?: string): Buffer {
  const v = (raw ?? "").trim();
  if (!v) return randomBytes(SALT_LEN);
  if (!/^[0-9a-fA-F]+$/.test(v) || v.length % 2 !== 0) {
    throw new Error("dataflow: invalid hex salt");
  }
  const salt = Buffer.from(v, "hex");
  if (salt.length === 0) throw new Error("dataflow: invalid hex salt");
  return salt;
}

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
}

/** Seals plaintext under key with a fresh random IV (ciphertext includes the GCM tag). */
export function encrypt(key: Buffer, plaintext: Buffer): Sealed {
  const iv = randomBytes(IV_LEN);
  return { ciphertext: sealWithIv(key, plaintext, iv), iv };
}

/** seal() with a caller-supplied IV — used by the cross-language test vectors. */
export function sealWithIv(key: Buffer, plaintext: Buffer, iv: Buffer): Buffer {
  if (key.length !== KEY_LEN) throw new Error("dataflow: key must be 32 bytes");
  if (iv.length !== IV_LEN) throw new Error("dataflow: invalid iv length");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** Opens ciphertext under key using iv. Throws on tag mismatch (wrong key). */
export function decrypt(key: Buffer, ciphertext: Buffer, iv: Buffer): Buffer {
  if (key.length !== KEY_LEN) throw new Error("dataflow: key must be 32 bytes");
  if (iv.length !== IV_LEN) throw new Error("dataflow: invalid iv length");
  if (ciphertext.length < 16) throw new Error("dataflow: decrypt failed (wrong key?)");
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error("dataflow: decrypt failed (wrong key?)");
  }
}
