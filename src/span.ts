import { performance } from "node:perf_hooks";

import { classifyPII } from "./pii.js";
import { encrypt } from "./crypto.js";
import { envelope, message } from "./envelope.js";
import { newId } from "./ids.js";
import { settings, shouldSample } from "./config.js";
import { currentSpan } from "./context.js";
import { enqueue } from "./pipeline.js";
import type { EventWire, EventType, PayloadWire } from "./types.js";

export interface SpanOptions {
  type?: EventType;
  /** Explicit parent; defaults to the span active in the async context. */
  parent?: Span | null;
  /** Trace id override (trace joining via X-Dataflow-Trace-Id). */
  traceId?: string;
}

function jsonSafe(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

/**
 * One measured unit of work. Created via trace()/span()/startSpan() or the
 * HTTP middleware; shipped to the ingest API when end() is called.
 */
export class Span {
  readonly eventId = newId();
  readonly spanId = newId();
  readonly traceId: string;
  readonly parentSpanId: string;
  readonly startedAtMs = Date.now();
  readonly sampled: boolean;

  private _startHr = performance.now();
  private _type: EventType;
  private _name: string;
  private _metadata: Record<string, string> = {};
  private _payload: Record<string, unknown> | null = null;
  private _statusCode = 0;
  private _errorMessage = "";
  private _calleePackage = "";
  private _callerPackage = "";
  private _ended = false;
  private seq = 0;

  constructor(name: string, opts: SpanOptions = {}) {
    const parent = opts.parent === undefined ? currentSpan() : opts.parent;
    this._type = opts.type ?? "FUNCTION_CALL";
    this._name = name;
    this.sampled = shouldSample();
    this.traceId = opts.traceId ?? parent?.traceId ?? newId();
    this.parentSpanId = parent?.spanId ?? "";
    // Package-boundary attribution: a "pkg.Func"-style label pins the callee
    // (like the Go SDK parses its qualified names); route labels — with a
    // space or slash — have no package. The caller stays empty: JS cannot
    // attribute the calling module reliably, and caller==callee self-edges
    // would corrupt the flow graph layering.
    this._calleePackage = labelPackage(name);
  }

  /** Span label: a route template ("GET /api/users/:id") or function name. */
  get name(): string {
    return this._name;
  }

  get type(): EventType {
    return this._type;
  }

  /** @internal — the delivery pipeline stamps the sequence number at enqueue. */
  _setSeq(seq: number): void {
    this.seq = seq;
  }

  _setName(name: string): void {
    this._name = name;
    this._calleePackage = labelPackage(name);
  }

  /** @internal — trace joining via an incoming X-Dataflow-Trace-Id. */
  _joinTrace(traceId: string): void {
    (this as { traceId: string }).traceId = traceId;
  }

  _setType(type: EventType): void {
    this._type = type;
  }

  _setCalleePackage(pkg: string): void {
    this._calleePackage = pkg;
  }

  /**
   * Records a plaintext attribute (metrics-grade metadata). Values are
   * stringified, mirroring the fleet's string-string metadata map.
   */
  setAttr(key: string, value: unknown): this {
    if (!this._ended) this._metadata[key] = typeof value === "string" ? value : String(value);
    return this;
  }

  /** Records several attributes at once. */
  setAttrs(attrs: Record<string, unknown>): this {
    for (const [k, v] of Object.entries(attrs)) this.setAttr(k, v);
    return this;
  }

  /**
   * Captures input/output data. Payloads are encrypted client-side when an
   * encryption key is configured; field NAMES always travel as plaintext
   * metadata ("data.fields") with PII categories ("data.pii").
   */
  setData(key: string, value: unknown): this {
    if (!this._ended) {
      if (this._payload === null) this._payload = {};
      this._payload[key] = jsonSafe(value);
    }
    return this;
  }

  /**
   * Attaches an error to the span. The first error wins: later calls are
   * no-ops, so a specific error is not clobbered by the generic
   * "http 500" the HTTP middleware adds on its way out.
   */
  recordError(err: unknown): this {
    if (err === undefined || err === null || this._ended) return this;
    if (this._errorMessage === "") this._errorMessage = message(err);
    return this;
  }

  /** Records a numeric status (HTTP status code or gRPC code). */
  setStatus(code: number): this {
    if (!this._ended) this._statusCode = code;
    return this;
  }

  /** True between construction and end(). */
  get isRecording(): boolean {
    return !this._ended;
  }

  /**
   * Closes the span and enqueues it for delivery. Calling end() twice is a
   * no-op; unsampled spans are dropped.
   */
  end(): void {
    if (this._ended) return;
    this._ended = true;
    if (!this.sampled) return;

    const durationMs = Math.max(0, Math.round(performance.now() - this._startHr));

    const payloadKeys = this._payload ? Object.keys(this._payload).sort() : [];
    const metadata = { ...this._metadata };
    if (payloadKeys.length > 0) {
      metadata["data.fields"] = payloadKeys.join(",");
      const pii = classifyPII(payloadKeys);
      if (pii) metadata["data.pii"] = pii;
    }

    const ev: EventWire = {
      event_id: this.eventId,
      seq: this.seq,
      timestamp: this.startedAtMs,
      trace_id: this.traceId,
      span_id: this.spanId,
      parent_span_id: this.parentSpanId,
      type: this._type,
      service_name: settings().serviceName,
      name: this._name,
      caller_package: this._callerPackage,
      callee_package: this._calleePackage,
      function_name: this._type === "FUNCTION_CALL" ? this._name : "",
      duration_ms: durationMs,
      status_code: this._statusCode,
      error_message: this._errorMessage,
      payload: payloadKeys.length > 0 ? attachPayload(this._payload as Record<string, unknown>) : null,
      metadata,
    };
    enqueue(ev);
  }
}

/**
 * Serializes the payload snapshot and seals it when a key is configured;
 * base64 plaintext otherwise (visibility beats silence). Both shapes use
 * data_b64 — the REST ingest contract base64-decodes the field
 * unconditionally.
 */
function attachPayload(payload: Record<string, unknown>): PayloadWire {
  const raw = Buffer.from(safeJson(payload), "utf8");
  const env = envelope();
  if (env === null) {
    return { encrypted: false, data_b64: raw.toString("base64"), iv_b64: "", key_salt: "" };
  }
  try {
    const { ciphertext, iv } = encrypt(env.key, raw);
    return {
      encrypted: true,
      data_b64: ciphertext.toString("base64"),
      iv_b64: iv.toString("base64"),
      key_salt: env.saltHex,
    };
  } catch (err) {
    settings().logger(`payload encryption failed: ${message(err)}`);
    return { encrypted: false, data_b64: raw.toString("base64"), iv_b64: "", key_salt: "" };
  }
}

function safeJson(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({ capture_error: "payload marshal failed" });
  }
}

/** 'warehouse.Reserve' -> 'warehouse'; route labels have no package. */
export function labelPackage(name: string): string {
  if (name && !name.includes(" ") && !name.includes("/") && name.includes(".")) {
    return name.slice(0, name.lastIndexOf("."));
  }
  return "";
}
