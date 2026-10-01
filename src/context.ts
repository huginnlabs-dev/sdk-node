import { AsyncLocalStorage } from "node:async_hooks";

import type { Span } from "./span.js";

/**
 * Trace context rides on AsyncLocalStorage, so nested dataflow.trace/span
 * blocks — and code inside HTTP middleware — join the enclosing trace
 * automatically, across await points and timer callbacks.
 */

const als = new AsyncLocalStorage<Span>();

/** The span active in the current async context, if any. */
export function currentSpan(): Span | undefined {
  return als.getStore();
}

/** Runs fn with span installed as the current span. */
export function runWithSpan<T>(span: Span, fn: () => T): T {
  return als.run(span, fn);
}

/**
 * Binds the current async context to span from here on (used by fastify's
 * onRequest hook, where the rest of the request lifecycle is already
 * scheduled downstream of us).
 */
export function enterSpanContext(span: Span): void {
  als.enterWith(span);
}
