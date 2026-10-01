import http from "node:http";
import https from "node:https";
import type { ClientRequest } from "node:http";

import { enabled } from "./config.js";
import { currentSpan, runWithSpan } from "./context.js";
import { Span } from "./span.js";
import { isPromiseLike } from "./trace.js";
import { clipStack, pathOnly, TRACE_HEADER } from "./middleware/shared.js";
import { clipStatement, stmtSummary } from "./sqlsummary.js";

/**
 * Automatic instrumentation of outgoing traffic and database blocks:
 *
 *     dataflow.instrumentHttp();   // once, at startup
 *     ...                          // http/https/fetch calls emit HTTP_CLIENT
 *     dataflow.restoreHttp();      // undo everything
 *
 *     await dataflow.dbSpan("postgres", "SELECT * FROM orders", async () => {
 *       return pool.query("SELECT * FROM orders");
 *     });
 *
 * Everything here is best-effort: when the SDK is disabled the wrapped
 * calls pass straight through, and a failure while recording can never
 * break the call itself.
 */

const INSTRUMENTED = Symbol("dataflow.instrumented");

/** The shape we patch on http/https: the module's request/get exports. */
interface RequestModule {
  request: (...args: unknown[]) => ClientRequest;
  get: (...args: unknown[]) => ClientRequest;
}

type Instrumented = { [INSTRUMENTED]?: boolean };

interface HttpOriginals {
  mod: RequestModule;
  request: (...args: unknown[]) => ClientRequest;
  get: (...args: unknown[]) => ClientRequest;
}

let installed: HttpOriginals[] = [];
let originalFetch: typeof fetch | null = null;
let installedFetch = false;

/**
 * Instruments node:http, node:https and global fetch so every outgoing
 * call emits an HTTP_CLIENT span named "METHOD host/path" with
 * http.method / http.url metadata. When a trace is active (HTTP middleware,
 * dataflow.trace, ...) the span joins it and the request gains an
 * X-Dataflow-Trace-Id header — unless the caller already set one — so a
 * downstream Dataflow service continues the same trace. With no active
 * trace the span still ships (rooting a fresh one) but no header is added.
 *
 * Patching mutates the module objects' request/get exports — the same
 * objects every require()/import hands out — so instrumentation works even
 * after other modules were loaded. Idempotent: calling it twice wraps
 * once. Undo everything with restoreHttp().
 */
export function instrumentHttp(): void {
  installModule(http);
  installModule(https);
  installFetch();
}

/** Restores the original http/https functions and global fetch. */
export function restoreHttp(): void {
  for (const orig of installed) {
    orig.mod.request = orig.request;
    orig.mod.get = orig.get;
  }
  installed = [];
  if (installedFetch && originalFetch !== null) {
    // Only undo our own wrapper; never clobber a later third-party wrap.
    if ((globalThis.fetch as Instrumented)[INSTRUMENTED] === true) {
      globalThis.fetch = originalFetch;
    }
    installedFetch = false;
    originalFetch = null;
  }
}

function installModule(mod: unknown): void {
  const target = mod as RequestModule;
  if ((target.request as Instrumented)[INSTRUMENTED] === true) return; // already ours: skip

  const originalRequest: (...args: unknown[]) => ClientRequest = target.request;
  const originalGet: (...args: unknown[]) => ClientRequest = target.get;

  const wrappedRequest = function (this: unknown, ...args: unknown[]): ClientRequest {
    return tracedRequest(mod, originalRequest, this, args);
  } as ((...args: unknown[]) => ClientRequest) & Instrumented;
  wrappedRequest[INSTRUMENTED] = true;

  // get() = request() + end(): delegate to the (patched) request export so
  // the span is opened exactly once, in the request wrapper.
  const wrappedGet = function (this: unknown, ...args: unknown[]): ClientRequest {
    const req = (target.request as (...a: unknown[]) => ClientRequest).apply(this, args);
    req.end();
    return req;
  } as ((...args: unknown[]) => ClientRequest) & Instrumented;
  wrappedGet[INSTRUMENTED] = true;

  target.request = wrappedRequest;
  target.get = wrappedGet;
  installed.push({ mod: target, request: originalRequest, get: originalGet });
}

/**
 * One instrumented http/https request: opens the HTTP_CLIENT span, injects
 * the trace header and closes the span on response, error or sync throw.
 */
function tracedRequest(
  mod: unknown,
  originalRequest: (...args: unknown[]) => ClientRequest,
  thisArg: unknown,
  args: unknown[],
): ClientRequest {
  const isHttps = mod === https;
  if (!enabled()) {
    return originalRequest.apply(thisArg, args);
  }

  let span: Span | null = null;
  let outArgs: unknown[] = args;
  try {
    const parsed = parseRequestArgs(args, isHttps);
    if (parsed !== null) {
      span = new Span(`${parsed.method} ${parsed.host}${parsed.path}`, { type: "HTTP_CLIENT" });
      span.setAttr("http.method", parsed.method);
      span.setAttr("http.url", parsed.url);
      span._setCalleePackage(parsed.host);
      // Header only when this call joins an active trace (the span's own
      // fresh trace id means "no current trace" — nothing to propagate).
      if (span.parentSpanId !== "" && !hasTraceHeader(parsed.headers)) {
        outArgs = injectHeader(args, parsed.optionsIndex, span.traceId);
      }
    }
  } catch {
    // Parsing must never break the call; fall through uninstrumented.
  }

  let req: ClientRequest;
  try {
    req = originalRequest.apply(thisArg, outArgs);
  } catch (err) {
    if (span !== null) {
      finishClientSpan(span, 503, err);
    }
    throw err;
  }
  if (span === null) return req;

  req.once("response", (res) => {
    // Attached before the request is queued (Node defers the write), so
    // this observes the response even when the user passed a callback.
    // end() is idempotent when an 'error' follows.
    finishClientSpan(span as Span, res.statusCode ?? 0, null);
  });
  req.once("error", (err) => {
    finishClientSpan(span as Span, 503, err);
  });
  return req;
}

/** Sets the final status and closes a client span; never throws. */
function finishClientSpan(span: Span, status: number, err: unknown): void {
  try {
    if (err !== null && err !== undefined) span.recordError(err);
    span.setStatus(status);
    if (status >= 500) span.recordError(`http ${status}`);
    span.end();
  } catch {
    // best-effort
  }
}

interface ParsedRequest {
  method: string;
  host: string;
  /** Path as written (query included) — used for the http.url metadata. */
  pathFull: string;
  /** Query-stripped path — used for the span name, like Go's URL.Path. */
  path: string;
  url: string;
  headers: unknown;
  optionsIndex: number;
}

/**
 * Extracts method/host/path/url from http.request's flexible argument
 * shapes — (options), (url), (url, options), plus a trailing callback —
 * mirroring Node's own merge: an options object overrides the URL parts.
 */
function parseRequestArgs(args: unknown[], isHttps: boolean): ParsedRequest | null {
  let urlArg: string | URL | null = null;
  let options: Record<string, unknown> | null = null;
  let optionsIndex = -1;

  const first = args[0];
  if (typeof first === "string") urlArg = first;
  else if (first instanceof URL) urlArg = first;
  else if (isPlainObject(first)) {
    options = first;
    optionsIndex = 0;
  }
  if (options === null && isPlainObject(args[1])) {
    options = args[1] as Record<string, unknown>;
    optionsIndex = 1;
  }
  if (urlArg === null && options === null) return null;

  let method = "GET";
  let host = "";
  let pathFull = "/";

  if (urlArg !== null) {
    let u: URL;
    try {
      u = new URL(urlArg instanceof URL ? urlArg.href : urlArg);
    } catch {
      return null; // not something we can name; call through untouched
    }
    host = u.host;
    pathFull = u.pathname + u.search;
  }
  if (options !== null) {
    method = String(options.method ?? method).toUpperCase();
    const optHost = hostFromOptions(options);
    if (optHost !== "") host = optHost;
    if (typeof options.path === "string" && options.path !== "") pathFull = options.path;
  }

  return {
    method,
    host,
    pathFull,
    path: pathOnly(pathFull),
    url: `${options?.protocol ?? (isHttps ? "https:" : "http:")}//${host}${pathFull}`,
    headers: options?.headers,
    optionsIndex,
  };
}

/** options.host ("example.com:8080") or hostname + port composed. */
function hostFromOptions(options: Record<string, unknown>): string {
  if (typeof options.host === "string" && options.host !== "") return options.host;
  const hostname = typeof options.hostname === "string" ? options.hostname : "";
  if (hostname === "") return "";
  const port = options.port;
  return port === undefined || port === null || port === "" ? hostname : `${hostname}:${String(port)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof URL);
}

/** True when the caller's header bag already carries the trace header. */
function hasTraceHeader(headers: unknown): boolean {
  if (!isPlainObject(headers)) return false;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === TRACE_HEADER) return true;
  }
  return false;
}

/**
 * Returns args with an options object carrying the trace header. The
 * caller's options object is copied, never mutated. When no options object
 * exists one is spliced in after the URL argument (before any callback).
 */
function injectHeader(args: unknown[], optionsIndex: number, traceId: string): unknown[] {
  const out = [...args];
  if (optionsIndex >= 0) {
    const options = args[optionsIndex] as Record<string, unknown>;
    const headers = isPlainObject(options.headers) ? { ...options.headers } : {};
    headers[TRACE_HEADER] = traceId;
    out[optionsIndex] = { ...options, headers };
    return out;
  }
  // (url[, callback]) shapes: insert the options object before the callback.
  const insertAt = args.length > 1 && typeof args[1] === "function" ? 1 : args.length;
  out.splice(insertAt, 0, { headers: { [TRACE_HEADER]: traceId } });
  return out;
}

function installFetch(): void {
  if (installedFetch) return;
  const current = globalThis.fetch as (typeof fetch & Instrumented) | undefined;
  if (current === undefined || current[INSTRUMENTED] === true) return; // already ours
  originalFetch = current;

  const wrapped = function (this: unknown, input: string | URL | Request, init?: RequestInit): Promise<Response> {
    return tracedFetch(originalFetch as typeof fetch, this, input, init);
  } as ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) & Instrumented;
  wrapped[INSTRUMENTED] = true;
  globalThis.fetch = wrapped as typeof fetch;
  installedFetch = true;
}

async function tracedFetch(
  original: typeof fetch,
  thisArg: unknown,
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<Response> {
  if (!enabled()) return original.call(thisArg, input, init);

  let span: Span | null = null;
  let outInit: RequestInit | undefined = init;
  let urlText = "";
  try {
    urlText =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : typeof input.url === "string"
            ? input.url
            : "";
    if (urlText !== "") {
      const u = new URL(urlText);
      const inputIsRequest = input instanceof Request;
      const method = String(
        init?.method ?? (inputIsRequest ? input.method : undefined) ?? "GET",
      ).toUpperCase();
      span = new Span(`${method} ${u.host}${pathOnly(u.pathname + u.search)}`, { type: "HTTP_CLIENT" });
      span.setAttr("http.method", method);
      span.setAttr("http.url", urlText);
      span._setCalleePackage(u.host);
      if (span.parentSpanId !== "") {
        const headers = new Headers(init?.headers ?? (inputIsRequest ? input.headers : undefined));
        if (!headers.has(TRACE_HEADER)) {
          headers.set(TRACE_HEADER, span.traceId);
          outInit = { ...init, headers };
        }
      }
    }
  } catch {
    // best-effort: fall through to a plain call
  }

  try {
    const resp = await original.call(thisArg, input, outInit);
    if (span !== null) finishClientSpan(span, resp.status, null);
    return resp;
  } catch (err) {
    if (span !== null) finishClientSpan(span, 503, err);
    throw err;
  }
}

/**
 * Wraps one block in a DB_QUERY span named after the statement summary
 * ("SELECT orders"), with the db system as the callee and the statement —
 * single-spaced, truncated to 200 characters, never any parameter values —
 * under db.statement. Status 200 on success, 500 plus error.stack on
 * failure; the error is always re-thrown.
 *
 *     await dataflow.dbSpan("postgres", "SELECT * FROM orders WHERE id = $1", async () => {
 *       return pool.query("SELECT * FROM orders WHERE id = $1", [id]);
 *     });
 */
export function dbSpan<T>(system: string, statement: string, fn: (span: Span) => T): T {
  const span = new Span(stmtSummary(statement), { type: "DB_QUERY" });
  span._setCalleePackage(system);
  span.setAttr("db.system", system);
  const clipped = clipStatement(statement);
  if (clipped !== "") span.setAttr("db.statement", clipped);

  let result: T;
  try {
    result = runWithSpan(span, () => fn(span));
  } catch (err) {
    span.recordError(err);
    span.setStatus(500);
    const stack = clipStack(err instanceof Error ? err.stack : undefined);
    if (stack) span.setAttr("error.stack", stack);
    span.end();
    throw err;
  }
  if (isPromiseLike(result)) {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        span.setStatus(200);
        span.end();
        return value as T;
      },
      (err: unknown) => {
        span.recordError(err);
        span.setStatus(500);
        const stack = clipStack(err instanceof Error ? err.stack : undefined);
        if (stack) span.setAttr("error.stack", stack);
        span.end();
        throw err;
      },
    ) as unknown as T;
  }
  span.setStatus(200);
  span.end();
  return result;
}
