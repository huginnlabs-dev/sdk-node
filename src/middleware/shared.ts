import type { IncomingHttpHeaders } from "node:http";

import { Span } from "../span.js";
import { agentAttrs } from "../agent.js";

/**
 * Shared machinery for the HTTP server integrations (express, fastify,
 * plain node:http): span naming, trace joining, agent stamping, redacted
 * header capture and the completion epilogue — one code path, three faces.
 */

/** Headers whose values never leave the host process (mirrors the fleet). */
export const REDACTED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);

export const TRACE_HEADER = "x-dataflow-trace-id";

export const ERROR_STACK_LIMIT = 8192;

export function clipStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  return stack.length > ERROR_STACK_LIMIT ? stack.slice(0, ERROR_STACK_LIMIT) : stack;
}

export function headerValue(headers: IncomingHttpHeaders | Record<string, unknown>, name: string): string {
  const v = (headers as Record<string, unknown>)[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0] as string;
  return "";
}

export function pathOnly(url: string | undefined): string {
  if (!url) return "/";
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  let end = url.length;
  if (q >= 0) end = q;
  if (h >= 0 && h < end) end = h;
  return url.slice(0, end) || "/";
}

export interface ServerSpanOptions {
  method: string;
  rawPath: string;
  headers: IncomingHttpHeaders | Record<string, unknown>;
  remoteAddr?: string | null;
  /** When true the span stamps agent.* host metadata (entry-point spans). */
  stampAgent?: boolean;
}

/**
 * Opens the HTTP_SERVER span for one request: named "METHOD path" (the
 * route template replaces the raw path at completion when the framework
 * exposes one), joined onto an incoming X-Dataflow-Trace-Id.
 */
export function startServerSpan(opts: ServerSpanOptions): Span {
  const span = new Span(`${opts.method} ${opts.rawPath}`, { type: "HTTP_SERVER" });
  const incoming = headerValue(opts.headers, TRACE_HEADER);
  if (incoming) {
    // Join: the caller started this trace (downstream Dataflow service).
    span._joinTrace(incoming);
  }
  if (opts.stampAgent !== false) {
    for (const [k, v] of agentAttrs()) span.setAttr(k, v);
  }
  span.setAttr("http.method", opts.method);
  span.setAttr("http.path", opts.rawPath);
  if (opts.remoteAddr) span.setAttr("http.remote_addr", opts.remoteAddr);
  captureHeaders(span, opts.headers);
  return span;
}

function captureHeaders(span: Span, headers: IncomingHttpHeaders | Record<string, unknown>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    const key = `http.header.${lower}`;
    if (REDACTED_HEADERS.has(lower)) {
      span.setAttr(key, "[REDACTED]");
      continue;
    }
    span.setAttr(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
}

export interface ServerSpanEpilogue {
  span: Span;
  method: string;
  status: number;
  /** Route template from the framework ("GET /api/users/:id"); the baseUrl prefix must already be applied. */
  routeTemplate?: string | null;
}

/** Completion epilogue: final name, status attrs, generic 5xx error. */
export function finishServerSpan(epi: ServerSpanEpilogue): void {
  const { span, method, status } = epi;
  if (epi.routeTemplate) {
    span._setName(`${method} ${epi.routeTemplate}`);
    span.setAttr("http.route", epi.routeTemplate);
  }
  span.setStatus(status);
  span.setAttr("http.status_code", String(status));
  // First error wins: an error recorded via the error middleware/onError
  // survives this generic marker, and vice versa.
  if (status >= 500) span.recordError(`http ${status}`);
  span.end();
}

/** Best-effort X-Dataflow-Trace-Id on the response (headers may be sent already). */
export function setTraceHeader(set: (name: string, value: string) => unknown, traceId: string): void {
  try {
    set(TRACE_HEADER, traceId);
  } catch {
    // headers already flushed (streaming response): skip
  }
}
