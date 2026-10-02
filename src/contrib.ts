import { format } from "node:util";

import { enabled, resolveHttpBase } from "./config.js";
import { runWithSpan } from "./context.js";
import { Span } from "./span.js";
import { isPromiseLike } from "./trace.js";
import {
  clipStack,
  finishServerSpan,
  pathOnly,
  setTraceHeader,
  startServerSpan,
  TRACE_HEADER,
} from "./middleware/shared.js";
import { instrumentServer } from "./middleware/http.js";
import { middleware as expressMiddleware } from "./middleware/express.js";
import { clipStatement, stmtSummary } from "./sqlsummary.js";
import {
  debug as logDebug,
  error as logError,
  info as logInfo,
  warn as logWarn,
} from "./logs.js";

/**
 * Library integrations: opt-in instrumentation for popular drivers and
 * loggers, plus a Traced method decorator. Every wrapper follows the same
 * contract as instrumentHttp()/captureConsole():
 *
 * - marker-symbol idempotency: a second call wraps nothing;
 * - originals are kept and restored by identity (restorePg() & friends
 *   never clobber a later third-party patch);
 * - the host call is forwarded first and unguarded — its behavior,
 *   arguments, return value and thrown errors are preserved verbatim;
 * - recording is best-effort and can never break or alter the call;
 * - while the SDK is disabled the wrappers pass straight through;
 * - the SDK's own network traffic goes through the pristine fetch, so no
 *   integration ever traces itself.
 */
const INSTRUMENTED = Symbol("dataflow.instrumented");

type Instrumented = { [INSTRUMENTED]?: boolean };

/** One patched method, kept so a restore can undo it. */
interface PatchInstall {
  owner: Record<string, unknown>;
  key: string;
  original: (...args: unknown[]) => unknown;
  wrapper: (...args: unknown[]) => unknown;
}

function newInstalls(): PatchInstall[] {
  return [];
}

let installedPg = newInstalls();
let installedMysql = newInstalls();
let installedPino = newInstalls();
let installedWinston = newInstalls();
let installedMongoose = newInstalls();
let installedAxios: AxiosInstall[] = [];
let installedKoa: KoaInstall[] = [];
let installedHttpServers: HttpServerInstall[] = [];

/** Clears an object-level install marker so a later call can re-instrument. */
function clearMarker(target: object): void {
  try {
    delete (target as Instrumented)[INSTRUMENTED];
  } catch {
    // non-configurable property: leave it, the install is gone regardless
  }
}

/**
 * Finds the object that owns the method — an instance property or a class
 * prototype — so patching the prototype (the instrumentHttp() pattern)
 * covers every instance of the class, while own-property stubs still work.
 */
function findMethodOwner(target: object, key: string): Record<string, unknown> | null {
  let cur: object | null = target;
  while (cur !== null && cur !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(cur, key)) {
      return cur as Record<string, unknown>;
    }
    cur = Object.getPrototypeOf(cur);
  }
  return null;
}

function patchMethod(
  installs: PatchInstall[],
  target: object,
  key: string,
  wrap: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
): void {
  const owner = findMethodOwner(target, key);
  if (owner === null) return;
  const current = owner[key];
  if (typeof current !== "function") return;
  if ((current as Instrumented)[INSTRUMENTED] === true) return; // already ours: skip

  const original = current as (...args: unknown[]) => unknown;
  const wrapper = wrap(original) as ((...args: unknown[]) => unknown) & Instrumented;
  wrapper[INSTRUMENTED] = true;
  try {
    owner[key] = wrapper;
  } catch {
    return; // non-writable property: stay uninstrumented, never throw
  }
  installs.push({ owner, key, original, wrapper });
}

/** Restores the originals recorded in one install list, by identity. */
function unpatchAll(installs: PatchInstall[]): void {
  for (const { owner, key, original, wrapper } of installs) {
    // Only undo our own wrapper; never clobber a later third-party patch.
    if (owner[key] === wrapper) owner[key] = original;
  }
}

// ---------------------------------------------------------------------------
// Database drivers (pg, mysql2)
// ---------------------------------------------------------------------------

/** The query method's first argument: a statement string or a config object. */
function extractStatement(args: unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return first;
  if (typeof first === "object" && first !== null) {
    const text = (first as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/**
 * Records err (status 500, error.stack clipped) on a span and closes it.
 * Best-effort: never throws.
 */
function failSpan(span: Span, err: unknown): void {
  try {
    span.recordError(err);
    span.setStatus(500);
    const stack = clipStack(err instanceof Error ? err.stack : undefined);
    if (stack) span.setAttr("error.stack", stack);
    span.end();
  } catch {
    // best-effort
  }
}

/**
 * Wraps a trailing callback argument (the pg/mysql2 callback style) so the
 * span closes with the callback's error — status 500 — or success — 200.
 * Forwarding to the caller's callback is unguarded: recording can never
 * prevent or alter it.
 */
function wrapTrailingCallback(args: unknown[], span: Span): { outArgs: unknown[] } | null {
  if (args.length === 0) return null;
  const last = args[args.length - 1];
  if (typeof last !== "function") return null;
  const outArgs = [...args];
  outArgs[outArgs.length - 1] = function (this: unknown, err: unknown, ...rest: unknown[]): unknown {
    try {
      if (err !== null && err !== undefined) {
        span.recordError(err);
        span.setStatus(500);
        const stack = clipStack(err instanceof Error ? err.stack : undefined);
        if (stack) span.setAttr("error.stack", stack);
      } else {
        span.setStatus(200);
      }
      span.end();
    } catch {
      // best-effort: the callback still runs
    }
    return last.apply(this, [err, ...rest]);
  };
  return { outArgs };
}

/**
 * Closes a span after a promise-style call settles. The caller's return
 * value is passed through untouched — Promise.resolve() adopts thenables
 * (pg's Query is one) without replacing anything.
 */
function observeSettlement(span: Span, result: unknown): void {
  if (!isPromiseLike(result)) {
    try {
      span.setStatus(200);
      span.end();
    } catch {
      // best-effort
    }
    return;
  }
  void Promise.resolve(result).then(
    () => {
      try {
        span.setStatus(200);
        span.end();
      } catch {
        // best-effort
      }
    },
    (err: unknown) => failSpan(span, err),
  );
}

/** Builds the query()-style wrapper shared by pg and mysql2. */
function makeQueryWrapper(
  system: string,
  original: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  return function (this: unknown, ...args: unknown[]): unknown {
    if (!enabled()) return original.apply(this, args);

    let span: Span | null = null;
    try {
      const statement = extractStatement(args);
      span = new Span(stmtSummary(statement), { type: "DB_QUERY" });
      span._setCalleePackage(system);
      span.setAttr("db.system", system);
      const clipped = clipStatement(statement);
      if (clipped !== "") span.setAttr("db.statement", clipped);
    } catch {
      span = null;
    }
    if (span === null) return original.apply(this, args);

    const cb = wrapTrailingCallback(args, span);
    const outArgs = cb !== null ? cb.outArgs : args;

    let result: unknown;
    try {
      result = runWithSpan(span, () => original.apply(this, outArgs));
    } catch (err) {
      failSpan(span, err);
      throw err;
    }
    if (cb !== null) return result;
    observeSettlement(span, result);
    return result;
  };
}

/**
 * Instruments a pg Pool or Client (or any duck-typed object with a
 * query() method) so every call emits a DB_QUERY span named after the
 * statement summary ("SELECT orders"), with db.system "postgres" and the
 * statement — single-spaced, 200 characters max, never any bind values —
 * under db.statement. Promise-style and callback-style calls both work;
 * arguments and return values are passed through untouched.
 *
 *     const pool = new pg.Pool();
 *     dataflow.instrumentPg(pool);   // or instrumentPg(client)
 *     ...
 *     dataflow.restorePg();          // undo
 */
export function instrumentPg(target: object): void {
  patchMethod(installedPg, target, "query", (original) => makeQueryWrapper("postgres", original));
}

/** Restores the query() methods patched by instrumentPg(). */
export function restorePg(): void {
  unpatchAll(installedPg);
  installedPg = newInstalls();
}

/**
 * Instruments a mysql2 connection or pool so query() AND execute() (the
 * prepared-statement flavour) emit DB_QUERY spans — same shape as the pg
 * wrapper, with db.system "mysql".
 *
 *     dataflow.instrumentMysql(pool);
 *     ...
 *     dataflow.restoreMysql();       // undo
 */
export function instrumentMysql(target: object): void {
  patchMethod(installedMysql, target, "query", (original) => makeQueryWrapper("mysql", original));
  patchMethod(installedMysql, target, "execute", (original) => makeQueryWrapper("mysql", original));
}

/** Restores the query()/execute() methods patched by instrumentMysql(). */
export function restoreMysql(): void {
  unpatchAll(installedMysql);
  installedMysql = newInstalls();
}

// ---------------------------------------------------------------------------
// HTTP servers (koa, nest)
// ---------------------------------------------------------------------------

/**
 * Minimal structural surface of a Koa application (koa 2/3). The SDK has
 * zero runtime dependencies — koa itself appears only as a devDependency
 * of the SDK's own test suite.
 */
interface KoaContextLike {
  method?: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  status?: number;
  set?: (name: string, value: string) => unknown;
  res?: { once(event: string, listener: () => void): unknown } | null;
  /** koa-router (@koa/router) stamps the matched route here. */
  _matchedRoute?: unknown;
}

interface KoaAppLike {
  use(fn: unknown): unknown;
  /** koa composes this array in registration order. */
  middleware?: unknown[];
}

type KoaMiddleware = (ctx: KoaContextLike, next: () => Promise<void>) => Promise<void>;

interface KoaInstall {
  app: KoaAppLike;
  mw: KoaMiddleware;
}

/**
 * Builds the dataflow Koa middleware: opens an HTTP_SERVER span per request
 * (named "METHOD <path>", renamed to the route template koa-router left on
 * ctx._matchedRoute when one appears), sets the X-Dataflow-Trace-Id
 * response header and closes the span with the final ctx.status when the
 * raw response finishes. Downstream middleware runs inside the span's
 * async context, so everything under the request joins the trace; a throw
 * is recorded on the span (with a clipped error.stack) and re-raised so
 * koa's own error handling — ctx.onerror, app.on('error') — still runs.
 */
function makeKoaMiddleware(): KoaMiddleware {
  return (ctx, next) => {
    if (!enabled()) {
      return next();
    }
    let span: Span | null = null;
    let finish: (() => void) | null = null;
    try {
      const method = String(ctx.method ?? "GET").toUpperCase();
      const rawPath = ctx.path ?? "/";
      span = startServerSpan({
        method,
        rawPath,
        headers: ctx.headers,
        remoteAddr: ctx.ip ?? null,
      });
      setTraceHeader((name, value) => ctx.set?.(name, value), span!.traceId);
      let done = false;
      finish = (): void => {
        if (done) return;
        done = true;
        const route =
          typeof ctx._matchedRoute === "string" && ctx._matchedRoute !== ""
            ? ctx._matchedRoute
            : null;
        finishServerSpan({ span: span as Span, method, status: ctx.status ?? 0, routeTemplate: route });
      };
      // Koa answers on the raw ServerResponse under ctx.res: 'finish' (or
      // 'close' on a client abort) fires with the final status in place.
      const res = ctx.res;
      if (res && typeof res.once === "function") {
        res.once("finish", finish);
        res.once("close", finish);
      } else {
        finish = null; // nothing observable to hang on: close on settle below
      }
    } catch {
      // Span setup must never break the app: fall through uninstrumented.
      span = null;
      finish = null;
    }
    if (span === null) return next();

    const active = span;
    // next() runs inside the span's async context (AsyncLocalStorage), so
    // handlers, DB calls and loggers under the request join the trace. The
    // async wrapper turns a synchronous downstream throw into a rejection
    // we can record — koa then answers 500 exactly as without the SDK.
    const out = runWithSpan(active, async () => {
      try {
        await next();
      } catch (err) {
        try {
          active.recordError(err);
          const stack = clipStack(err instanceof Error ? err.stack : undefined);
          if (stack) active.setAttr("error.stack", stack);
        } catch {
          // best-effort
        }
        throw err;
      }
    });
    if (finish === null) {
      // No raw response reachable: end the span when the chain settles.
      void Promise.resolve(out).then(
        () => {
          try {
            active.setStatus(ctx.status ?? 0);
            active.end();
          } catch {
            // best-effort
          }
        },
        () => {
          try {
            active.setStatus(500);
            active.end();
          } catch {
            // best-effort
          }
        },
      );
    }
    return out;
  };
}

/**
 * Instruments a Koa application by mounting the dataflow middleware via
 * app.use() — Ktor-style — and returns a remover that splices it back out
 * of app.middleware. Mount before your routes so the span wraps the whole
 * request; spans are HTTP_SERVER ("GET /users/:id" once koa-router has
 * matched, else the raw path). Idempotent per app; restoreKoa() undoes
 * every install.
 *
 *     const app = new Koa();
 *     const remove = dataflow.instrumentKoa(app);
 *     ...
 *     remove();                      // or dataflow.restoreKoa()
 */
export function instrumentKoa(app: object): () => void {
  const a = app as KoaAppLike & Instrumented;
  if (a[INSTRUMENTED] === true || typeof a.use !== "function") return (): void => {};

  const mw = makeKoaMiddleware();
  try {
    a.use(mw);
  } catch {
    return (): void => {}; // non-cooperative app: stay uninstrumented
  }
  a[INSTRUMENTED] = true;
  const install: KoaInstall = { app: a, mw };
  installedKoa.push(install);
  return (): void => {
    const at = installedKoa.indexOf(install);
    if (at >= 0) installedKoa.splice(at, 1);
    spliceMiddleware(a, mw);
  };
}

function spliceMiddleware(app: KoaAppLike, mw: unknown): void {
  const stack = app.middleware;
  if (!Array.isArray(stack)) return;
  const at = stack.indexOf(mw);
  if (at >= 0) stack.splice(at, 1);
}

/** Restores every middleware mounted by instrumentKoa(). */
export function restoreKoa(): void {
  for (const { app, mw } of [...installedKoa]) spliceMiddleware(app, mw);
  installedKoa = [];
}

/** The surface of instrumentNest() reads off a NestJS application. */
interface NestAppLike {
  getHttpAdapter?: () => unknown;
  getHttpServer?: () => unknown;
}

/** The express-shaped instance Nest wraps (whatever adapter is in play). */
interface ExpressLikeInstance {
  use(fn: unknown): unknown;
}

/** node:http server surface instrumentHttpServer() operates on. */
interface ListenerLike {
  listeners(name: string): unknown[];
  off(name: string, listener: (...args: unknown[]) => void): unknown;
  on(name: string, listener: (...args: unknown[]) => void): unknown;
}

interface HttpServerInstall {
  server: ListenerLike;
  pairs: { original: (...args: unknown[]) => void; wrapped: (...args: unknown[]) => void }[];
}

/**
 * Wraps a plain node:http server's request listeners with the core
 * instrumentServer() handler — the framework-agnostic fallback for servers
 * we cannot reach as express apps (Nest's fastify adapter, bare servers,
 * connect-style stacks). Returns a remover that swaps the originals back
 * in (order preserved), or null when there is nothing wired yet. Never
 * throws; idempotent per server.
 */
export function instrumentHttpServer(server: object): (() => void) | null {
  const s = server as ListenerLike & Instrumented;
  if (s[INSTRUMENTED] === true || typeof s.listeners !== "function") return null;

  const originals = s
    .listeners("request")
    .filter((l): l is (...args: unknown[]) => void => typeof l === "function");
  if (originals.length === 0) return null;

  const pairs: HttpServerInstall["pairs"] = [];
  for (const original of originals) {
    const wrapped = instrumentServer(
      original as Parameters<typeof instrumentServer>[0],
    ) as (...args: unknown[]) => void;
    try {
      s.off("request", original);
      s.on("request", wrapped);
      pairs.push({ original, wrapped });
    } catch {
      // leave this listener untouched
    }
  }
  if (pairs.length === 0) return null;
  s[INSTRUMENTED] = true;

  const install: HttpServerInstall = { server: s, pairs };
  installedHttpServers.push(install);
  return (): void => {
    const at = installedHttpServers.indexOf(install);
    if (at >= 0) installedHttpServers.splice(at, 1);
    for (const { original, wrapped } of pairs) {
      try {
        s.off("request", wrapped);
        s.on("request", original);
      } catch {
        // best-effort
      }
    }
    clearMarker(s);
  };
}

/** Restores every node:http server wrapped by instrumentHttpServer(). */
export function restoreNest(): void {
  for (const { server, pairs } of [...installedHttpServers]) {
    for (const { original, wrapped } of pairs) {
      try {
        server.off("request", wrapped);
        server.on("request", original);
      } catch {
        // best-effort
      }
    }
    clearMarker(server);
  }
  installedHttpServers = [];
}

/**
 * Instruments a NestJS application. Nest hosts apps on an adapter — almost
 * always express — reached as app.getHttpAdapter().getInstance(): the
 * dataflow express middleware chain is mounted there with .use(), so spans
 * carry real route templates. Call before app.init()/app.listen() so the
 * middleware sits in front of the routes Nest registers during init.
 * Removing an already-registered express middleware is not supported —
 * restart the app to undo.
 *
 * When no express-shaped instance is reachable (fastify adapter, custom
 * adapter, server not built yet), the underlying node:http server from
 * app.getHttpServer() is wrapped with the framework-agnostic core handler
 * instead (span names fall back to "METHOD <path>"). Safe to call on any
 * shape: unreachable adapters pass through untouched, and it never throws.
 *
 *     const app = await NestFactory.create(AppModule);
 *     dataflow.instrumentNest(app);
 *     await app.listen(3000);
 */
export function instrumentNest(app: object): void {
  const a = app as NestAppLike & Instrumented;
  if (a[INSTRUMENTED] === true) return;

  // Preferred: the express instance Nest wraps — same chain as
  // dataflow.middleware() on a hand-rolled express app. Note the instance
  // is itself a function (express apps are callable).
  const adapter = typeof a.getHttpAdapter === "function" ? a.getHttpAdapter() : null;
  const instance =
    adapter !== null &&
    (typeof adapter === "object" || typeof adapter === "function") &&
    typeof (adapter as { getInstance?: unknown }).getInstance === "function"
      ? (adapter as { getInstance: () => unknown }).getInstance()
      : null;
  if (
    instance !== null &&
    (typeof instance === "object" || typeof instance === "function") &&
    typeof (instance as ExpressLikeInstance).use === "function"
  ) {
    const express = instance as ExpressLikeInstance & Instrumented;
    if (express[INSTRUMENTED] !== true) {
      try {
        express.use(expressMiddleware());
        express[INSTRUMENTED] = true;
        a[INSTRUMENTED] = true;
        return;
      } catch {
        // fall through to the http-server fallback
      }
    }
    return;
  }

  // Fallback: wrap whatever node:http server Nest built (or will build).
  const server = typeof a.getHttpServer === "function" ? a.getHttpServer() : null;
  if (
    server !== null &&
    typeof server === "object" &&
    instrumentHttpServer(server) !== null
  ) {
    a[INSTRUMENTED] = true;
  }
}

// ---------------------------------------------------------------------------
// HTTP client (axios)
// ---------------------------------------------------------------------------

/** Per-request hand-off of the open span from the request to the response interceptor. */
const AXIOS_SPAN: unique symbol = Symbol("dataflow.axiosSpan");

interface AxiosHeadersLike {
  set(name: string, value: string): unknown;
}

interface AxiosConfigLike {
  url?: string;
  baseURL?: string;
  method?: string;
  headers?: AxiosHeadersLike | Record<string, unknown>;
  [AXIOS_SPAN]?: Span | undefined;
}

interface AxiosErrorLike extends Error {
  config?: AxiosConfigLike;
  response?: { status?: number };
}

interface AxiosResponseLike {
  status?: number;
  config?: AxiosConfigLike;
}

interface AxiosInterceptorRegistry {
  use(
    onFulfilled?: (value: never) => unknown,
    onRejected?: (error: never) => unknown,
  ): number;
  eject(id: number): void;
}

interface AxiosLike {
  interceptors: {
    request: AxiosInterceptorRegistry;
    response: AxiosInterceptorRegistry;
  };
}

interface AxiosInstall {
  instance: AxiosLike;
  requestIds: number[];
  responseIds: number[];
}

/**
 * True when urlText points at the SDK's own ingest endpoint — those
 * beacons must never trace themselves (scheme-insensitive host:port match
 * against the configured HTTP base).
 */
function isOwnEndpoint(urlText: string): boolean {
  const base = resolveHttpBase();
  if (base === null || urlText === "") return false;
  try {
    return new URL(urlText).host === new URL(base).host;
  } catch {
    return false;
  }
}

/** Resolves config.baseURL + config.url into an absolute URL when possible. */
function axiosUrl(config: AxiosConfigLike): { href: string; u: URL } | null {
  const base = typeof config.baseURL === "string" ? config.baseURL.trim() : "";
  const rel = typeof config.url === "string" ? config.url.trim() : "";
  if (base === "" && rel === "") return null;
  let candidate: string;
  if (base !== "" && rel !== "" && !/^https?:\/\//i.test(rel)) {
    candidate = `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
  } else {
    candidate = rel !== "" ? rel : base;
  }
  try {
    const u = new URL(candidate);
    return { href: u.href, u };
  } catch {
    return null; // relative-only or invalid: nothing to name the span after
  }
}

/** Sets the trace header on the axios config without duplicating one. */
function injectAxiosTraceHeader(config: AxiosConfigLike, traceId: string): void {
  const headers = config.headers;
  if (headers !== null && typeof headers === "object") {
    if (typeof (headers as AxiosHeadersLike).set === "function") {
      // AxiosHeaders (axios v1): case-insensitive set, no duplicates.
      (headers as AxiosHeadersLike).set(TRACE_HEADER, traceId);
      return;
    }
    const bag = headers as Record<string, unknown>;
    for (const key of Object.keys(bag)) {
      if (key.toLowerCase() === TRACE_HEADER) return; // caller set it
    }
    config.headers = { ...bag, [TRACE_HEADER]: traceId };
    return;
  }
  config.headers = { [TRACE_HEADER]: traceId };
}

/** Sets the final status and closes a client span; never throws. */
function finishAxiosSpan(span: Span, status: number, err: unknown): void {
  try {
    if (err !== null && err !== undefined) span.recordError(err);
    span.setStatus(status);
    if (status >= 500) span.recordError(`http ${status}`);
    span.end();
  } catch {
    // best-effort
  }
}

function axiosRequestInterceptor(config: AxiosConfigLike): AxiosConfigLike {
  if (!enabled()) return config;
  try {
    const parsed = axiosUrl(config);
    if (parsed === null || isOwnEndpoint(parsed.href)) return config;
    const method = String(config.method ?? "GET").toUpperCase();
    const span = new Span(
      `${method} ${parsed.u.host}${pathOnly(parsed.u.pathname + parsed.u.search)}`,
      { type: "HTTP_CLIENT" },
    );
    span.setAttr("http.method", method);
    span.setAttr("http.url", parsed.href);
    span._setCalleePackage(parsed.u.host);
    // Propagate only when joining an active trace — a root client span has
    // nothing downstream services could continue.
    if (span.parentSpanId !== "") injectAxiosTraceHeader(config, span.traceId);
    config[AXIOS_SPAN] = span;
  } catch {
    // best-effort: the request goes out uninstrumented
  }
  return config;
}

function axiosRequestRejected(err: AxiosErrorLike): never {
  // A failure upstream of the dispatch never gets a response — close
  // whatever span the config carries with the network-error status 503.
  const span = err?.config?.[AXIOS_SPAN];
  if (span) finishAxiosSpan(span, 503, err);
  throw err;
}

function axiosResponseFulfilled(response: AxiosResponseLike): AxiosResponseLike {
  const span = response?.config?.[AXIOS_SPAN];
  if (span) finishAxiosSpan(span, typeof response.status === "number" ? response.status : 200, null);
  return response;
}

function axiosResponseRejected(err: AxiosErrorLike): never {
  const span = err?.config?.[AXIOS_SPAN];
  if (span) {
    const status = typeof err.response?.status === "number" ? err.response.status : 503;
    finishAxiosSpan(span, status, err);
  }
  throw err;
}

/**
 * Instruments an axios instance (axios.create() or the default import) via
 * request/response interceptors: every call emits an HTTP_CLIENT span named
 * "METHOD host/path" with http.method / http.url metadata, and — when the
 * call joins an active trace — an X-Dataflow-Trace-Id header so a
 * downstream Dataflow service continues the trace. Requests that fail
 * before a response (connection refused, timeout, chain rejection) close
 * the span with status 503 and the recorded error. Beacons aimed at the
 * SDK's own ingest endpoint are skipped (isOwnEndpoint).
 *
 * Idempotent per instance; restoreAxios() ejects every interceptor by
 * identity. While the SDK is disabled requests pass straight through.
 *
 *     const api = axios.create({ baseURL: "https://api.example.com" });
 *     dataflow.instrumentAxios(api);
 *     ...
 *     dataflow.restoreAxios();       // undo
 */
export function instrumentAxios(instance: object): void {
  const inst = instance as unknown as AxiosLike & Instrumented;
  if (inst[INSTRUMENTED] === true) return;
  const request = inst.interceptors?.request;
  const response = inst.interceptors?.response;
  if (
    !request ||
    typeof request.use !== "function" ||
    !response ||
    typeof response.use !== "function"
  ) {
    return;
  }
  try {
    const requestId = request.use(
      axiosRequestInterceptor as (value: never) => unknown,
      axiosRequestRejected as (error: never) => unknown,
    );
    const responseId = response.use(
      axiosResponseFulfilled as (value: never) => unknown,
      axiosResponseRejected as (error: never) => unknown,
    );
    installedAxios.push({ instance: inst, requestIds: [requestId], responseIds: [responseId] });
    inst[INSTRUMENTED] = true;
  } catch {
    // registration failed: stay uninstrumented, never throw
  }
}

/** Ejects every interceptor registered by instrumentAxios(). */
export function restoreAxios(): void {
  for (const { instance, requestIds, responseIds } of [...installedAxios]) {
    for (const id of requestIds) {
      try {
        instance.interceptors.request.eject(id);
      } catch {
        // best-effort
      }
    }
    for (const id of responseIds) {
      try {
        instance.interceptors.response.eject(id);
      } catch {
        // best-effort
      }
    }
    clearMarker(instance);
  }
  installedAxios = [];
}

// ---------------------------------------------------------------------------
// MongoDB (mongoose)
// ---------------------------------------------------------------------------

/** Query/document slot for the open span (pre hook -> post hook hand-off). */
const MONGOOSE_SPAN: unique symbol = Symbol("dataflow.mongooseSpan");

/** The operations wired with pre/post middleware (pragmatic v1 set). */
const MONGOOSE_OPS: readonly string[] = [
  "find",
  "findOne",
  "countDocuments",
  "estimatedDocumentCount",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "save",
  "insertMany",
  "aggregate",
];

interface MongooseSchemaLike {
  pre?(op: string, fn: (...args: unknown[]) => void): unknown;
  post?(op: string, fn: (...args: unknown[]) => void): unknown;
}

interface MongooseModelLike {
  schema?: MongooseSchemaLike | null;
  modelName?: string;
}

/** "findOneAndUpdate" -> "FIND_ONE_AND_UPDATE" — the span-name verb. */
function mongooseVerb(op: string): string {
  return op.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/**
 * Registers query middleware on one schema: the pre hook opens a DB_QUERY
 * span ("FIND User", verb from the operation) inside the current trace,
 * the success post closes it with 200 and the error post with 500 plus a
 * clipped error.stack. Mongoose dispatches post hooks by arity — success
 * handlers take (docs, next), error handlers (err, docs, next) — so the
 * closures declare exactly those shapes. Idempotent per schema.
 */
function attachMongooseMiddleware(schema: object, modelName: string): void {
  if (modelName === "") return;
  const s = schema as MongooseSchemaLike & Instrumented;
  if (typeof s.pre !== "function" || typeof s.post !== "function") return;
  if (s[INSTRUMENTED] === true) return;

  const hooks = s as MongooseSchemaLike;
  s[INSTRUMENTED] = true;

  for (const op of MONGOOSE_OPS) {
    const label = `${mongooseVerb(op)} ${modelName}`;
    // The hook closures are cast to the generic registry signature — the
    // precise declared arity matters at runtime (mongoose dispatches post
    // hooks by fn.length), not for the structural type.
    hooks.pre!(
      op,
      function (
        this: unknown,
        next: (...args: unknown[]) => void,
        ...rest: unknown[]
      ): void {
        if (!enabled()) {
          next(...rest);
          return;
        }
        let span: Span | null = null;
        try {
          span = new Span(label, { type: "DB_QUERY" });
          span._setCalleePackage("mongodb");
          span.setAttr("db.system", "mongodb");
          span.setAttr("db.operation", op);
          span.setAttr("db.model", modelName);
          (this as Record<symbol, Span | undefined>)[MONGOOSE_SPAN] = span;
        } catch {
          span = null;
        }
        if (span === null) {
          next(...rest);
          return;
        }
        // The query executes downstream of next(), inside the span context:
        // parallel handlers, populate() calls and loggers join the trace.
        runWithSpan(span, () => next(...rest));
      } as (...args: unknown[]) => void,
    );
    hooks.post!(
      op,
      function (this: unknown, _docs: unknown, next: () => void): void {
        closeMongooseSpan(this, 200, null);
        next();
      } as (...args: unknown[]) => void,
    );
    hooks.post!(
      op,
      function (
        this: unknown,
        err: unknown,
        _docs: unknown,
        next: (e?: unknown) => void,
      ): void {
        closeMongooseSpan(this, 500, err);
        next(err);
      } as (...args: unknown[]) => void,
    );
  }
}

/** Closes the span a pre hook stashed on the query/document. */
function closeMongooseSpan(thisArg: unknown, status: number, err: unknown): void {
  const slot = thisArg as Record<symbol, Span | undefined> | null | undefined;
  const span = slot !== null && slot !== undefined ? slot[MONGOOSE_SPAN] : undefined;
  if (!span) return;
  try {
    if (err !== null && err !== undefined) {
      span.recordError(err);
      const stack = clipStack(err instanceof Error ? err.stack : undefined);
      if (stack) span.setAttr("error.stack", stack);
    }
    span.setStatus(status);
    span.end();
  } catch {
    // best-effort
  }
}

function isSchemaLike(value: unknown): value is MongooseSchemaLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as MongooseSchemaLike).pre === "function" &&
    typeof (value as MongooseSchemaLike).post === "function"
  );
}

function isModelLike(value: unknown): value is MongooseModelLike {
  // Compiled mongoose models are constructors (functions) carrying static
  // schema/modelName; duck-typed fakes may hand us plain objects.
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as MongooseModelLike).schema === "object"
  );
}

/** Attaches middleware to one compiled-or-future model, best-effort. */
function attachMongooseModel(model: unknown): void {
  if (!isModelLike(model) || model.schema === null || model.schema === undefined) return;
  if (!isSchemaLike(model.schema)) return;
  attachMongooseMiddleware(model.schema, typeof model.modelName === "string" ? model.modelName : "");
}

/** Iterates connection.models — an array (modern mongoose) or a hash. */
function eachExistingModel(connection: MongooseConnLike, fn: (model: unknown) => void): void {
  const models = connection.models;
  if (Array.isArray(models)) {
    for (const m of models) fn(m);
    return;
  }
  if (models !== null && typeof models === "object") {
    for (const m of Object.values(models)) fn(m);
  }
}

interface MongooseConnLike {
  model?(...args: unknown[]): unknown;
  models?: unknown;
}

function makeMongooseModelWrapper(
  original: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  return function (this: unknown, ...args: unknown[]): unknown {
    // Hook the schema BEFORE the model compiles so the middleware is in
    // place from the first query (mongoose consults the schema's hooks at
    // exec time, so later registration works too — this is just tidier).
    try {
      const name = args[0];
      const schema = args[1];
      if (typeof name === "string" && isSchemaLike(schema)) {
        attachMongooseMiddleware(schema, name);
      }
    } catch {
      // best-effort
    }
    // Forward unguarded: compilation behavior is preserved verbatim.
    const out = original.apply(this, args);
    try {
      // Model factories without an explicit schema argument still get a
      // span-armed schema off the compiled model (covers cached models).
      attachMongooseModel(out);
    } catch {
      // best-effort
    }
    return out;
  };
}

/**
 * Instruments a mongoose connection so queries and saves emit DB_QUERY
 * spans: the connection's model() factory is wrapped so every model gets
 * pre/post middleware for find, findOne, updateOne, updateMany, deleteOne,
 * deleteMany, save, insertMany and aggregate — a span "FIND User" /
 * "SAVE User" (verb from the operation, db.system "mongodb") per
 * execution, joining the active trace as a child.
 * Models compiled BEFORE the call are covered too (connection.models is
 * walked once at install).
 *
 * Idempotent per connection; restoreMongoose() unwraps the factory —
 * middleware already attached to schemas stays (mongoose has no hook
 * removal), but models created after the restore stay uninstrumented.
 *
 *     await mongoose.connect(uri);
 *     dataflow.instrumentMongoose(mongoose.connection);
 *     ...
 *     dataflow.restoreMongoose();    // undo
 */
export function instrumentMongoose(connection: object): void {
  const conn = connection as MongooseConnLike;
  if (typeof conn.model !== "function") return;
  patchMethod(installedMongoose, connection, "model", makeMongooseModelWrapper);
  try {
    eachExistingModel(conn, attachMongooseModel);
  } catch {
    // best-effort: new models are still covered by the factory wrapper
  }
}

/** Restores the model() factory patched by instrumentMongoose(). */
export function restoreMongoose(): void {
  unpatchAll(installedMongoose);
  installedMongoose = newInstalls();
}

// ---------------------------------------------------------------------------
// Loggers (pino, winston)
// ---------------------------------------------------------------------------

type LogForward = (message: string, fields?: Record<string, unknown>) => void;

/** pino level -> Dataflow level (fatal escalates to error). */
const PINO_METHOD_LEVELS: Readonly<Record<string, LogForward>> = {
  debug: logDebug,
  info: logInfo,
  warn: logWarn,
  error: logError,
  fatal: logError,
};

/** Formats a logger call the way console itself would print it. */
function formatLogArgs(args: unknown[]): string {
  try {
    return format(...args);
  } catch {
    return args
      .map((a) => {
        try {
          return String(a);
        } catch {
          return "[unstringifiable]";
        }
      })
      .join(" ");
  }
}

/**
 * Builds a wrapper that forwards to the original logger method first —
 * output behaves exactly as without the SDK, including anything it throws
 * — and then records the line via the Dataflow log pipeline.
 */
function makeForwardingWrapper(
  forward: LogForward,
  original: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  return function (this: unknown, ...args: unknown[]): unknown {
    const out = original.apply(this, args);
    try {
      forward(formatLogArgs(args));
    } catch {
      // best-effort
    }
    return out;
  };
}

/**
 * Instruments a pino logger so info/warn/error/debug/fatal calls are
 * forwarded to the original method AND recorded via the log pipeline
 * (fatal -> error). Idempotent; restorePino() undoes it. While the SDK is
 * disabled output still forwards, nothing is recorded.
 *
 *     const logger = pino();
 *     dataflow.instrumentPino(logger);
 *     ...
 *     dataflow.restorePino();        // undo
 */
export function instrumentPino(logger: object): void {
  for (const [method, forward] of Object.entries(PINO_METHOD_LEVELS)) {
    patchMethod(installedPino, logger, method, (original) => makeForwardingWrapper(forward, original));
  }
}

/** Restores the level methods patched by instrumentPino(). */
export function restorePino(): void {
  unpatchAll(installedPino);
  installedPino = newInstalls();
}

/** winston level -> Dataflow level; unknown levels ride at debug. */
function winstonLevel(level: string): "debug" | "info" | "warn" | "error" {
  const l = level.trim().toLowerCase();
  if (l === "error") return "error";
  if (l === "warn" || l === "warning") return "warn";
  if (l === "info") return "info";
  return "debug";
}

/** The message of a winston info object (string, {message}, or Error). */
function winstonMessage(info: unknown): string {
  if (typeof info === "string") return info;
  if (typeof info === "object" && info !== null) {
    const message = (info as { message?: unknown }).message;
    if (typeof message === "string") return message;
    if (message !== undefined && message !== null) {
      try {
        return String(message);
      } catch {
        return "[unstringifiable]";
      }
    }
  }
  return String(info);
}

function forwardForLevel(level: string): LogForward {
  switch (winstonLevel(level)) {
    case "error":
      return logError;
    case "warn":
      return logWarn;
    case "info":
      return logInfo;
    default:
      return logDebug;
  }
}

function makeWinstonWriteWrapper(
  original: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  return function (this: unknown, ...args: unknown[]): unknown {
    // Forward FIRST, unguarded: transports behave exactly as without the SDK.
    const out = original.apply(this, args);
    try {
      const info = args[0];
      const level =
        typeof info === "object" && info !== null ? (info as { level?: unknown }).level : undefined;
      if (info !== undefined && info !== null) {
        const record = forwardForLevel(typeof level === "string" ? level : "");
        record(winstonMessage(info));
      }
    } catch {
      // best-effort
    }
    return out;
  };
}

/**
 * Instruments a winston logger by wrapping logger.write — the single
 * funnel every level method goes through — so lines are forwarded to the
 * transports AND recorded via the log pipeline (info/warn/error map
 * directly, everything else — http/verbose/debug/silly and custom levels —
 * rides at debug). Idempotent; restoreWinston() undoes it.
 *
 *     const logger = winston.createLogger({ ... });
 *     dataflow.instrumentWinston(logger);
 *     ...
 *     dataflow.restoreWinston();     // undo
 */
export function instrumentWinston(logger: object): void {
  patchMethod(installedWinston, logger, "write", makeWinstonWriteWrapper);
}

/** Restores the write() method patched by instrumentWinston(). */
export function restoreWinston(): void {
  unpatchAll(installedWinston);
  installedWinston = newInstalls();
}

// ---------------------------------------------------------------------------
// Traced decorator / wrapper
// ---------------------------------------------------------------------------

/**
 * Runs fn in a FUNCTION_CALL span named name — a child of the active trace
 * when one is open, a fresh root otherwise. Success closes the span with
 * status 200; a failure (sync throw or rejected async) records the error
 * with status 500 and a clipped error.stack, then re-throws the original
 * error. The return value (and promise) passes through.
 *
 *     await dataflow.traced("payments.Charge", async (span) => {
 *       span.setData("order", order);
 *       return charge(order);
 *     });
 */
export function traced<T>(name: string, fn: (span: Span) => T): T {
  const span = new Span(name, { type: "FUNCTION_CALL" });
  let result: T;
  try {
    result = runWithSpan(span, () => fn(span));
  } catch (err) {
    failSpan(span, err);
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
        failSpan(span, err);
        throw err;
      },
    ) as unknown as T;
  }
  span.setStatus(200);
  span.end();
  return result;
}

/** Options for the Traced() decorator. */
export interface TracedOptions {
  /** Span name; defaults to the decorated method's own name. */
  name?: string;
}

/**
 * TypeScript 5 standard method decorator (also works in plain JS via
 * `dataflow.Traced()(Klass.prototype.method, context)`):
 *
 *     class Payments {
 *       @Traced()
 *       async charge(order: Order) { ... }
 *
 *       @Traced({ name: "warehouse.Reserve" })
 *       reserve(order: Order) { ... }
 *     }
 *
 * Equivalent to wrapping the method body in dataflow.traced(name, fn): a
 * FUNCTION_CALL child span per call — status 200 on success, 500 plus a
 * clipped error.stack on failure, original error re-thrown, `this`
 * preserved. Requires the standard decorators of TS 5+ (the repo tsconfig
 * does not enable experimentalDecorators).
 */
export function Traced(
  opts: TracedOptions = {},
): <This, Args extends unknown[], R>(
  target: (this: This, ...args: Args) => R,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => R>,
) => (this: This, ...args: Args) => R {
  return (target, context) => {
    const name = opts.name ?? String(context.name);
    return function (this, ...args) {
      return traced(name, () => target.apply(this, args));
    };
  };
}
