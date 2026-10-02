import { format } from "node:util";

import { enabled } from "./config.js";
import { runWithSpan } from "./context.js";
import { Span } from "./span.js";
import { isPromiseLike } from "./trace.js";
import { clipStack } from "./middleware/shared.js";
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
