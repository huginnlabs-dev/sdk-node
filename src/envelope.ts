import { deriveKey, saltFromHex } from "./crypto.js";
import { settings } from "./config.js";

/**
 * The per-process encryption envelope: the payload key derived once from
 * DATAFLOW_ENCRYPTION_KEY with a 16-byte salt (DATAFLOW_SALT hex, or a
 * fresh random one). Empty saltHex means "encryption off" — payloads ship
 * as base64 JSON with encrypted:false.
 */

export interface Envelope {
  key: Buffer;
  saltHex: string;
}

let cached: Envelope | null | undefined;

/** Returns the envelope, or null when no key is configured / setup failed. */
export function envelope(): Envelope | null {
  if (cached !== undefined) return cached;
  const s = settings();
  if (!s.encryptionKey) {
    cached = null;
    return cached;
  }
  try {
    const salt = saltFromHex(s.salt);
    cached = { key: deriveKey(s.encryptionKey, salt), saltHex: salt.toString("hex") };
  } catch (err) {
    s.logger(`payload encryption disabled, key setup failed: ${message(err)}`);
    cached = null;
  }
  return cached;
}

/** Test seam: forget the derived envelope so the next use re-derives it. */
export function _resetEnvelopeForTests(): void {
  cached = undefined;
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
