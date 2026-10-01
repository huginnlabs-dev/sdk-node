import { enabled } from "./config.js";
import { currentSpan } from "./context.js";
import { Span } from "./span.js";
import { clipStack, ERROR_STACK_LIMIT } from "./middleware/shared.js";
import { isPromiseLike } from "./trace.js";

/**
 * Crash capture: exception evidence onto the current span, mirroring the
 * fleet's panic.go / crash.py wire contract (WS4) — status 500,
 * error_message = String(err) truncated to 500 characters, and the
 * "error.stack" metadata carrying the stack clipped to
 * ERROR_STACK_LIMIT (8192) characters from the TOP (the throwing frames).
 *
 * Nothing here ever swallows an error: capture() re-throws the original,
 * and the process handlers only record — they add listeners next to any
 * the host already has. All recording is guarded, so a failure while
 * recording can never mask the original crash.
 */

const CRASH_MESSAGE_MAX = 500;
const SYNTHETIC_SPAN = "exception";
const UNCAUGHT_SPAN = "uncaught exception";

/**
 * Runs fn, recording any error on the active span (or a short-lived
 * synthetic "exception" span when nothing is being traced) before
 * re-throwing the original error unchanged:
 *
 *     dataflow.capture(() => process(order));       // sync
 *     await dataflow.capture(async () => ...);      // async
 */
export function capture<T>(fn: () => T): T {
  let result: T;
  try {
    result = fn();
  } catch (err) {
    recordCrash(err, SYNTHETIC_SPAN);
    throw err;
  }
  if (isPromiseLike(result)) {
    return (result as unknown as Promise<unknown>).then(
      (value) => value as T,
      (err: unknown) => {
        recordCrash(err, SYNTHETIC_SPAN);
        throw err;
      },
    ) as unknown as T;
  }
  return result;
}

let crashHandlersInstalled = false;

/**
 * Installs process-level uncaughtException / unhandledRejection handlers
 * that record escaping crashes on synthetic "uncaught exception" spans
 * (same wire shape as capture()). Idempotent; a no-op while the SDK is
 * disabled (nothing is installed, nothing is recorded).
 *
 * WARNING: Node suppresses the default crash-and-exit whenever ANY
 * uncaughtException listener is present — installing this changes process
 * exit behavior (unhandled rejections likewise). Pair the call with your
 * own exit logic, e.g.:
 *
 *     dataflow.captureUncaught();
 *     process.on("uncaughtException", () => process.exit(1));
 *
 * restoreCrash() removes the Dataflow handlers again.
 */
export function captureUncaught(): void {
  if (!enabled() || crashHandlersInstalled) return;
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
  crashHandlersInstalled = true;
}

/** Removes the handlers installed by captureUncaught(). */
export function restoreCrash(): void {
  if (!crashHandlersInstalled) return;
  process.off("uncaughtException", onUncaughtException);
  process.off("unhandledRejection", onUnhandledRejection);
  crashHandlersInstalled = false;
}

function onUncaughtException(err: Error): void {
  recordCrash(err, UNCAUGHT_SPAN);
}

function onUnhandledRejection(reason: unknown): void {
  recordCrash(reason, UNCAUGHT_SPAN);
}

/**
 * Best-effort recording: the span active in the async context, else a
 * short-lived synthetic span so background crashes still ship. Guarded
 * end to end — recording must never raise into the crash path.
 */
function recordCrash(err: unknown, syntheticName: string): void {
  if (!enabled() || err === null || err === undefined) return;
  try {
    let span = currentSpan();
    let synthetic: Span | null = null;
    if (span === undefined) {
      synthetic = new Span(syntheticName);
      span = synthetic;
    }
    try {
      const stack = clipStack(err instanceof Error ? err.stack : undefined);
      if (stack) span.setAttr("error.stack", stack);
      span.recordError(String(err).slice(0, CRASH_MESSAGE_MAX));
      span.setStatus(500);
    } finally {
      synthetic?.end();
    }
  } catch {
    // best-effort: never mask the original error
  }
}

/** Exposed for the README/tests: the wire clip limits of crash capture. */
export const CRASH_LIMITS = {
  messageChars: CRASH_MESSAGE_MAX,
  stackChars: ERROR_STACK_LIMIT,
} as const;
