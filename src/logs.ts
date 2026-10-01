import { format } from "node:util";

import { enabled, resolveHttpBase, settings } from "./config.js";
import { currentSpan } from "./context.js";
import { rawFetch } from "./net.js";
import type { LogWire } from "./types.js";

/**
 * Application log shipping with trace correlation:
 *
 *     dataflow.info("order shipped", { order_id: order.id });
 *     dataflow.captureConsole();   // console.* lines ship too
 *     ...
 *     await dataflow.flushLogs();  // best-effort final flush
 *
 * Lines recorded inside dataflow.trace()/middleware contexts carry that
 * span's trace_id/span_id; outside a trace both ids are empty. Records land
 * in a bounded ring buffer (1024 lines, drop-oldest) drained by a
 * best-effort flusher — every 500ms, at 50 buffered lines, or via
 * flushLogs() — POSTing {"logs":[...]} to {base}/api/v1/logs with a
 * 5s timeout, one retry, then drop.
 *
 * Everything here never blocks or throws into the host app, and all POSTs
 * go through the pristine fetch (net.ts) so log shipping never creates
 * HTTP_CLIENT spans of itself.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const FLUSH_INTERVAL_MS = 500;
const FLUSH_THRESHOLD_LINES = 50;
const MAX_BATCH_LINES = 1000; // server hard cap per POST
const RING_CAPACITY = 1024; // in-memory lines, drop-oldest
const MESSAGE_MAX_CHARS = 8192; // server clamps messages at 8KB
const FIELD_COUNT_MAX = 50; // server clamps fields at 50 x 512
const FIELD_VALUE_MAX_CHARS = 512;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 2; // one retry, then drop
const SHUTDOWN_TIMEOUT_MS = 2000;

/** Exposed for the README/tests: the wire limits of log shipping. */
export const LOG_LIMITS = {
  batchLines: MAX_BATCH_LINES,
  bufferLines: RING_CAPACITY,
  messageChars: MESSAGE_MAX_CHARS,
  fieldCount: FIELD_COUNT_MAX,
  fieldValueChars: FIELD_VALUE_MAX_CHARS,
} as const;

const buffer: LogWire[] = [];
let dropped = 0;
let timer: NodeJS.Timeout | null = null;
let flushChain: Promise<void> = Promise.resolve();
let warnedNoBase = false;
let shutdownHooked = false;

// Unit-test seam: when set, drained batches go to the sink instead of the
// network (log tests assert on the wire objects without an HTTP server).
let sink: ((logs: LogWire[]) => void) | null = null;

/** @internal — test seam only. */
export function _setLogsSinkForTests(fn: ((logs: LogWire[]) => void) | null): void {
  sink = fn;
}

/** @internal — buffered/dropped line counts (tests and diagnostics). */
export function logStats(): { buffered: number; dropped: number } {
  return { buffered: buffer.length, dropped };
}

/**
 * Normalizes a caller-supplied level: case-insensitive, "log" -> "info",
 * "warning" -> "warn"; anything unrecognized falls back to "info".
 */
export function normalizeLevel(level: string): LogLevel {
  const l = level.trim().toLowerCase();
  if (l === "debug") return "debug";
  if (l === "warn" || l === "warning") return "warn";
  if (l === "error") return "error";
  return "info";
}

/** Records at debug level. Never throws. */
export function debug(message: string, fields?: Record<string, unknown>): void {
  record("debug", message, fields);
}

/** Records at info level. Never throws. */
export function info(message: string, fields?: Record<string, unknown>): void {
  record("info", message, fields);
}

/** Records at warn level. Never throws. */
export function warn(message: string, fields?: Record<string, unknown>): void {
  record("warn", message, fields);
}

/** Records at error level. Never throws. */
export function error(message: string, fields?: Record<string, unknown>): void {
  record("error", message, fields);
}

/**
 * Records at an arbitrary level, normalized by normalizeLevel()
 * ("log" -> "info", "warning" -> "warn"). Never throws.
 */
export function log(level: string, message: string, fields?: Record<string, unknown>): void {
  record(normalizeLevel(level), message, fields);
}

/**
 * One best-effort record: stamped with the current span's trace/span ids
 * (empty outside a trace) into the bounded ring buffer, then flushed at
 * the 50-line threshold. Disabled/unconfigured SDK: silent no-op.
 */
function record(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (!enabled()) return;
  try {
    const span = currentSpan();
    addLine({
      timestamp: Date.now(),
      level,
      message: clip(message, MESSAGE_MAX_CHARS),
      trace_id: span?.traceId ?? "",
      span_id: span?.spanId ?? "",
      service_name: settings().serviceName,
      fields: stringifyFields(fields),
    });
  } catch {
    // best-effort: a hostile message/fields object must never throw in
  }
  ensureFlusher();
  if (buffer.length >= FLUSH_THRESHOLD_LINES) void flushLogs();
}

/** Ring-buffer insert: drop-oldest at capacity, counting every drop. */
function addLine(line: LogWire): void {
  if (buffer.length >= RING_CAPACITY) {
    buffer.shift();
    dropped += 1;
  }
  buffer.push(line);
}

function stringifyFields(fields: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fields) return out;
  let entries: [string, unknown][];
  try {
    entries = Object.entries(fields);
  } catch {
    return out; // hostile proxy/getter: the line survives without fields
  }
  let count = 0;
  for (const [key, value] of entries) {
    if (count >= FIELD_COUNT_MAX) break;
    let s: string;
    try {
      s = String(value);
    } catch {
      s = "[unstringifiable]";
    }
    out[key] = clip(s, FIELD_VALUE_MAX_CHARS);
    count += 1;
  }
  return out;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Starts the background flusher once: a 500ms unref'd interval (it must
 * never hold a short-lived process alive) plus a best-effort final flush
 * on beforeExit, capped at SHUTDOWN_TIMEOUT_MS.
 */
function ensureFlusher(): void {
  if (timer !== null) return;
  timer = setInterval(() => void flushLogs(), FLUSH_INTERVAL_MS);
  timer.unref();
  if (!shutdownHooked) {
    shutdownHooked = true;
    process.once("beforeExit", () => {
      void withTimeout(flushLogs(), SHUTDOWN_TIMEOUT_MS);
    });
  }
}

/**
 * Drains the ring buffer to the logs API. Safe to call anytime; concurrent
 * calls share one flush, and callers that race a trigger simply join it.
 */
export function flushLogs(): Promise<void> {
  flushChain = flushChain.then(drainAll);
  return flushChain;
}

function drainAll(): Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  while (buffer.length > 0) {
    const batch = buffer.splice(0, MAX_BATCH_LINES);
    chain = chain.then(() => postBatch(batch));
  }
  return chain;
}

/** POSTs one batch with 5s timeout; one retry, then the batch is dropped. */
async function postBatch(batch: LogWire[]): Promise<void> {
  if (sink !== null) {
    sink(batch);
    return;
  }
  const base = resolveHttpBase();
  if (base === null) {
    // A bare host:port endpoint with no DATAFLOW_HTTP_URL has no derivable
    // HTTP base: logging stays off and buffered lines are dropped.
    warnNoBaseOnce();
    return;
  }
  const body = JSON.stringify({ logs: batch });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": settings().apiKey,
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // rawFetch: never instrumentHttp's wrapped fetch — log shipping must
      // not create HTTP_CLIENT spans of itself.
      const resp = await rawFetch(`${base}/api/v1/logs`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (resp.status >= 200 && resp.status < 300) return;
      // Non-transient 4xx means the server rejects this batch outright —
      // retrying would not help.
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
        settings().logger(
          `log ingest rejected batch (HTTP ${resp.status}); dropping ${batch.length} lines`,
        );
        return;
      }
      throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        settings().logger(
          `log ingest failed after ${attempt} attempts (${errorMessage(err)}); dropping ${batch.length} lines`,
        );
        return;
      }
      // Logs are best-effort: one immediate retry, no backoff, then drop.
    }
  }
}

function warnNoBaseOnce(): void {
  if (warnedNoBase) return;
  warnedNoBase = true;
  settings().logger(
    "DATAFLOW_ENDPOINT is a bare host:port with no DATAFLOW_HTTP_URL; " +
      "no HTTP base to POST logs to — log shipping stays off",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

async function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  await Promise.race([p, sleep(ms)]);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const CONSOLE_METHODS = ["debug", "log", "info", "warn", "error"] as const;
type ConsoleMethodName = (typeof CONSOLE_METHODS)[number];
type ConsoleFn = (...args: unknown[]) => void;

const LEVEL_BY_METHOD: Record<ConsoleMethodName, LogLevel> = {
  debug: "debug",
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
};

interface ConsoleInstall {
  name: ConsoleMethodName;
  original: ConsoleFn;
  wrapper: ConsoleFn;
}

let installs: ConsoleInstall[] | null = null;

/**
 * Wraps console.debug/log/info/warn/error so every call is FORWARDED to
 * the original method first — output (and anything it throws) is exactly
 * what the unpatched console would do; the wrapping can never swallow or
 * alter it — and then recorded as a log line (log -> info, warning-style
 * mapping per LEVEL_BY_METHOD). Idempotent: a second call is a no-op.
 * restoreConsole() puts the original methods back. While the SDK is
 * disabled the console still forwards, nothing is recorded.
 */
export function captureConsole(): void {
  if (installs !== null) return; // idempotent
  const pending: ConsoleInstall[] = [];
  for (const name of CONSOLE_METHODS) {
    const candidate = (console as unknown as Record<string, unknown>)[name];
    if (typeof candidate !== "function") continue;
    const original = candidate as ConsoleFn;
    const level = LEVEL_BY_METHOD[name];
    const wrapper = function (this: unknown, ...args: unknown[]): void {
      // Forward FIRST, unguarded: the original call's output and behavior —
      // including any error it raises — are preserved verbatim. Recording
      // below is best-effort and only runs when forwarding returned.
      original.apply(this, args);
      record(level, clip(formatConsoleArgs(args), MESSAGE_MAX_CHARS));
    };
    pending.push({ name, original, wrapper });
  }
  for (const { name, wrapper } of pending) {
    (console as unknown as Record<string, ConsoleFn>)[name] = wrapper;
  }
  installs = pending;
}

/** Restores the console methods captured by captureConsole(). */
export function restoreConsole(): void {
  const done = installs;
  if (done === null) return;
  installs = null;
  const bag = console as unknown as Record<string, unknown>;
  for (const { name, original, wrapper } of done) {
    // Only undo our own wrapper; never clobber a later third-party patch.
    if (bag[name] === wrapper) bag[name] = original;
  }
}

/** Formats console arguments the way console itself would print them. */
function formatConsoleArgs(args: unknown[]): string {
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

/** Test seam: forget all log state (buffer, timer, console, wiring). */
export function _resetLogsForTests(): void {
  restoreConsole();
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  buffer.length = 0;
  dropped = 0;
  warnedNoBase = false;
  sink = null;
  flushChain = Promise.resolve();
}
