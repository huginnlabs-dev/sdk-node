import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decrypt, deriveKey, encrypt, saltFromHex, sealWithIv } from "../src/crypto.js";

/**
 * Cross-language vectors generated with the Go SDK's exact encoder
 * semantics (crypto/pbkdf2.Key(sha256, …, 10000, 32) + AES-256-GCM seal):
 *
 *   secret    = "dataflow-test-secret"
 *   salt_hex  = 00112233445566778899aabbccddeeff
 *   iv_hex    = 000102030405060708090a0b
 *   plaintext = {"order_id":"A-123","total":42.5}
 *
 * Any other SDK deriving the same key and sealing the same plaintext must
 * produce byte-identical ciphertext, so the fleet's dashboards decrypt
 * Node payloads with the same key material they use for Go payloads.
 */
const GO_KEY_HEX = "7df52a822bbc036773d6d397b94f89f8912228af97045a5ce9fadcd3b4c1bd07";
const GO_SALT_HEX = "00112233445566778899aabbccddeeff";
const GO_IV_B64 = "AAECAwQFBgcICQoL";
const GO_CT_B64 = "Iaw3EgvpwTWZekb01+437N4jnwaAvSLb08CF6UKbqu91wbOqX+fBn0L40mn681JPwA==";
const PLAINTEXT = Buffer.from('{"order_id":"A-123","total":42.5}', "utf8");

describe("payload encryption (dataflow-go/encoder parity)", () => {
  it("derives the exact PBKDF2-SHA256 key the Go encoder derives", () => {
    const key = deriveKey("dataflow-test-secret", Buffer.from(GO_SALT_HEX, "hex"));
    expect(key.toString("hex")).toBe(GO_KEY_HEX);
  });

  it("matches the published PBKDF2-HMAC-SHA256 test vector (RFC 7914)", () => {
    // password="password", salt="salt", c=4096, dkLen=32
    const key = pbkdf2Sync("password", "salt", 4096, 32, "sha256");
    expect(key.toString("hex")).toBe("c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a");
  });

  it("seals byte-identical ciphertext with a fixed IV (AES-256-GCM, 96-bit nonce)", () => {
    const key = Buffer.from(GO_KEY_HEX, "hex");
    const iv = Buffer.from(GO_IV_B64, "base64");
    expect(iv.length).toBe(12);
    const ct = sealWithIv(key, PLAINTEXT, iv);
    expect(ct.toString("base64")).toBe(GO_CT_B64);
  });

  it("round-trips encrypt/decrypt and uses fresh 12-byte IVs", () => {
    const key = Buffer.from(GO_KEY_HEX, "hex");
    const { ciphertext, iv } = encrypt(key, PLAINTEXT);
    expect(iv.length).toBe(12);
    // ciphertext = encrypted body + 128-bit GCM tag
    expect(ciphertext.length).toBe(PLAINTEXT.length + 16);
    expect(decrypt(key, ciphertext, iv).equals(PLAINTEXT)).toBe(true);
  });

  it("fails to decrypt under a wrong key", () => {
    const key = Buffer.from(GO_KEY_HEX, "hex");
    const other = deriveKey("different-secret", Buffer.from(GO_SALT_HEX, "hex"));
    const { ciphertext, iv } = encrypt(key, PLAINTEXT);
    expect(() => decrypt(other, ciphertext, iv)).toThrow(/wrong key|decrypt failed/i);
  });

  it("decodes hex salts and generates 16 random bytes when unset", () => {
    expect(saltFromHex(GO_SALT_HEX).toString("hex")).toBe(GO_SALT_HEX);
    expect(saltFromHex(undefined).length).toBe(16);
    expect(saltFromHex("").length).toBe(16);
    expect(() => saltFromHex("zzzz")).toThrow(/invalid hex salt/);
    expect(() => saltFromHex("abc")).toThrow(/invalid hex salt/); // odd length
  });

  it("rejects malformed keys", () => {
    expect(() => sealWithIv(Buffer.alloc(16), PLAINTEXT, Buffer.alloc(12))).toThrow(/32 bytes/);
    expect(() => sealWithIv(Buffer.from(GO_KEY_HEX, "hex"), PLAINTEXT, Buffer.alloc(8))).toThrow(
      /invalid iv length/,
    );
  });
});
