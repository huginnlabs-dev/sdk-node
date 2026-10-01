import { randomBytes } from "node:crypto";

/**
 * Random 16-hex-character identifier — the fleet-wide ID shape (the Go SDK
 * emits 8 random bytes hex-encoded, Python truncates a UUID4 to 16 chars).
 * Trace/span/event IDs are opaque strings to the server; joining via the
 * X-Dataflow-Trace-Id header works regardless of the source SDK.
 */
export function newId(): string {
  return randomBytes(8).toString("hex");
}
