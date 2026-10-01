import { gzipSync } from "node:zlib";

import { enabled, resolveHttpBase, settings } from "./config.js";
import { EventBuffer } from "./buffer.js";
import { sendManifest } from "./manifest.js";
import type { EventWire } from "./types.js";

/**
 * The delivery pipeline: Span.end -> enqueue -> bounded buffer, drained by
 * POSTs to {base}/api/v1/ingest. Flushes every 500ms, at 100 buffered
 * events, or when the buffer passes 1MB. Failures retry with backoff and
 * drop after a few attempts — nothing ever throws into the host app.
 */

const FLUSH_INTERVAL_MS = 500;
const FLUSH_BATCH_COUNT = 100;
const FLUSH_BATCH_BYTES = 1024 * 1024; // 1MB
const MAX_BATCH_EVENTS = 2000; // server hard cap per POST
const GZIP_THRESHOLD = 4 * 1024; // gzip bodies over 4KB
const REQUEST_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 2000;

interface PipelineState {
  buf: EventBuffer;
  seq: number;
  timer: NodeJS.Timeout | null;
  /** Serializes flushes; triggers landing mid-flush re-run afterwards. */
  flushing: Promise<void>;
  warnedNoBase: boolean;
  shutdownHooked: boolean;
}

let state: PipelineState | null = null;

// Unit-test seam: when set, events go to the sink instead of the pipeline
// (span tests assert on the wire objects without a network).
let sink: ((ev: EventWire) => void) | null = null;

/** @internal — test seam only. */
export function _setSinkForTests(fn: ((ev: EventWire) => void) | null): void {
  sink = fn;
}

/**
 * Idempotently starts the pipeline once the SDK is enabled. Also reports
 * the service manifest (once per process, best-effort).
 */
export function ensureStarted(): void {
  if (state !== null) return;
  if (!enabled()) {
    warnPassive();
    return;
  }
  const s = settings();
  state = {
    buf: new EventBuffer(s.bufferSize),
    seq: 0,
    timer: null,
    flushing: Promise.resolve(),
    warnedNoBase: false,
    shutdownHooked: false,
  };

  state.timer = setInterval(() => void flushNow(), FLUSH_INTERVAL_MS);
  // The delivery timer must never keep a short-lived process alive.
  state.timer.unref();
  hookShutdown();
  // Report the service manifest (framework + dependency inventory) once;
  // best-effort, independent of the tracing pipeline.
  sendManifest();
}

function warnPassive(): void {
  const s = settings();
  if (s.disabled) return;
  if (!s.apiKey || !s.endpoint) {
    s.logger("DATAFLOW_API_KEY/DATAFLOW_ENDPOINT not set; SDK stays passive");
  }
}

/** Entry point from Span.end into the delivery path. */
export function enqueue(ev: EventWire): void {
  if (sink !== null) {
    sink(ev);
    return;
  }
  ensureStarted();
  const st = state;
  if (st === null) return; // disabled or unconfigured: drop silently
  st.seq += 1;
  ev.seq = st.seq;
  st.buf.add(ev);
  if (st.buf.length >= FLUSH_BATCH_COUNT || st.buf.bufferedBytes >= FLUSH_BATCH_BYTES) {
    void flushNow();
  }
}

/**
 * Drains the buffer to the ingest API. Safe to call anytime (tests and
 * shutdown included); concurrent calls share one flush.
 */
export function flushNow(): Promise<void> {
  const st = state;
  if (st === null || st.buf.length === 0) return Promise.resolve();
  st.flushing = st.flushing.then(() => drainAll(st));
  return st.flushing;
}

function drainAll(st: PipelineState): Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  while (st.buf.length > 0) {
    const batch = st.buf.drain(MAX_BATCH_EVENTS);
    chain = chain.then(() => postBatch(batch));
  }
  return chain;
}

/** POSTs one batch with retry/backoff; drops the batch after MAX_ATTEMPTS. */
async function postBatch(events: EventWire[]): Promise<void> {
  const base = resolveHttpBase();
  if (base === null) {
    warnNoBaseOnce();
    return; // nowhere to send: drop
  }
  const apiKey = settings().apiKey;
  let body = Buffer.from(JSON.stringify({ events }), "utf8");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": apiKey,
  };
  if (body.length > GZIP_THRESHOLD) {
    body = gzipSync(body);
    headers["Content-Encoding"] = "gzip";
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const resp = await fetch(`${base}/api/v1/ingest`, {
        method: "POST",
        headers,
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (resp.status >= 200 && resp.status < 300) return;
      // Non-transient 4xx means the server rejects this batch outright —
      // retrying would not help.
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
        settings().logger(`ingest rejected batch (HTTP ${resp.status}); dropping ${events.length} events`);
        return;
      }
      throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        settings().logger(
          `ingest failed after ${attempt} attempts (${errorMessage(err)}); dropping ${events.length} events`,
        );
        return;
      }
      await sleep(backoffMs(attempt));
    }
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 250);
}

function warnNoBaseOnce(): void {
  const st = state;
  if (st === null || st.warnedNoBase) return;
  st.warnedNoBase = true;
  settings().logger(
    "DATAFLOW_ENDPOINT is a bare host:port with no DATAFLOW_HTTP_URL; " +
      "no HTTP base to POST events to — SDK stays passive",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort final flush on process exit: `beforeExit` for clean exits,
 * SIGTERM/SIGINT for kills. Never blocks termination longer than
 * SHUTDOWN_TIMEOUT_MS and never swallows the app's own signal handlers.
 */
function hookShutdown(): void {
  const st = state;
  if (st === null || st.shutdownHooked) return;
  st.shutdownHooked = true;

  process.once("beforeExit", () => {
    void withTimeout(flushNow(), SHUTDOWN_TIMEOUT_MS);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void withTimeout(flushNow(), SHUTDOWN_TIMEOUT_MS);
    });
  }
}

async function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  await Promise.race([p, sleep(ms)]);
}

/** Snapshot of pipeline buffer state — used by tests and diagnostics. */
export function bufferedStats(): { events: number; bytes: number } {
  const st = state;
  if (st === null) return { events: 0, bytes: 0 };
  return { events: st.buf.length, bytes: st.buf.bufferedBytes };
}

/** Test seam: forget all pipeline state (buffer, timer, enqueue wiring). */
export function _resetForTests(): void {
  const st = state;
  if (st?.timer) clearInterval(st.timer);
  state = null;
  sink = null;
}
