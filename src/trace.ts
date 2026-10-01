import { Span } from "./span.js";
import { runWithSpan } from "./context.js";
import type { EventType } from "./types.js";

/**
 * The tracing helpers: they open a span, install it as the current async
 * context, run the callback and end the span — sync and async alike.
 * When a span is already active (e.g. the request is being traced by HTTP
 * middleware) the new span joins the same trace as its child; otherwise it
 * roots a fresh trace.
 */

export type TraceFn<T> = (span: Span) => T;

function runTraced<T>(name: string, fn: TraceFn<T>, type: EventType): T {
  // Parent resolves to the span active in the async context (undefined here
  // means "look it up", so nested calls join the enclosing trace).
  const span = new Span(name, { type });
  let result: T;
  try {
    result = runWithSpan(span, () => fn(span));
  } catch (err) {
    span.recordError(err);
    span.end();
    throw err;
  }
  if (isPromiseLike(result)) {
    // Async callback: end after settlement; the ALS context rides the
    // promise chain, so awaited children stay inside the trace.
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        span.end();
        return value as T;
      },
      (err: unknown) => {
        span.recordError(err);
        span.end();
        throw err;
      },
    ) as unknown as T;
  }
  span.end();
  return result;
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Traces a block as a span named name (e.g. "warehouse.Reserve"). Root
 * span when nothing is being traced, child of the active span otherwise.
 *
 *     await dataflow.trace("payments.Charge", async (span) => {
 *       span.setData("order", order);
 *       ...
 *     });
 */
export function trace<T>(name: string, fn: TraceFn<T>): T {
  return runTraced(name, fn, "FUNCTION_CALL");
}

/**
 * The explicit child flavour of trace(): parents to the span active in the
 * current async context (fresh root when there is none).
 */
export function span<T>(name: string, fn: TraceFn<T>): T {
  return runTraced(name, fn, "FUNCTION_CALL");
}

/**
 * Opens a child of the currently active span without running a callback —
 * call end() exactly once when the work is done. Advanced use; prefer
 * trace()/span(). `opts.parent` pins an explicit parent; `opts.type`
 * selects the wire event type (HTTP_CLIENT, DB_QUERY, ...).
 */
export function startSpan(
  name: string,
  opts: { type?: EventType; parent?: Span | null } = {},
): Span {
  return new Span(name, { type: opts.type, parent: opts.parent });
}
