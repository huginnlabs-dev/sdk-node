import { enabled } from "../config.js";
import { runWithSpan } from "../context.js";
import { Span } from "../span.js";
import {
  clipStack,
  finishServerSpan,
  pathOnly,
  setTraceHeader,
  startServerSpan,
  TRACE_HEADER,
} from "./shared.js";
import { DATAFLOW_SPAN } from "./spankey.js";
import type { NextFunction, ServerRequestLike, ServerResponseLike } from "./types.js";

/**
 * Express middleware. Wrap with app.use(dataflow.middleware()) and — to
 * capture handler errors — register dataflow.errorMiddleware() LAST, after
 * all routes:
 *
 *     app.use(dataflow.middleware());
 *     app.get("/users/:id", handler);
 *     app.use(dataflow.errorMiddleware());
 *
 * Spans are HTTP_SERVER, named "METHOD <route template>" once the router
 * has matched (mounted routers include their baseUrl prefix), falling back
 * to the raw path for unmatched requests (404s). Incoming
 * X-Dataflow-Trace-Id headers join upstream traces; responses carry the
 * same header so downstream Dataflow services fan the trace out.
 */

type ExpressMiddleware = (req: ServerRequestLike, res: ServerResponseLike, next: NextFunction) => void;

type ExpressErrorMiddleware = (
  err: unknown,
  req: ServerRequestLike,
  res: ServerResponseLike,
  next: NextFunction,
) => void;

export function middleware(): ExpressMiddleware {
  return (req, res, next) => {
    if (!enabled()) {
      next();
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    const rawPath = req.path ?? pathOnly(req.url);
    const span = startServerSpan({
      method,
      rawPath,
      headers: req.headers,
      remoteAddr: req.socket?.remoteAddress ?? null,
    });
    (req as unknown as Record<symbol, Span | undefined>)[DATAFLOW_SPAN] = span;
    setTraceHeader((name, value) => res.setHeader(name, value), span.traceId);

    // 'finish' = response fully handed to the OS; 'close' = connection
    // torn down early (client abort). Whichever fires first ends the span.
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      const route = routeTemplate(req);
      finishServerSpan({ span, method, status: res.statusCode, routeTemplate: route });
    };
    res.once("finish", finish);
    res.once("close", finish);

    // next() inside the ALS context: every downstream handler joins the
    // request trace automatically.
    runWithSpan(span, () => next());
  };
}

/** Route template ("users/:id") with the mount prefix ("/api") applied. */
function routeTemplate(req: ServerRequestLike): string | null {
  const routePath = req.route?.path;
  if (typeof routePath !== "string" || routePath === "") return null;
  const base = typeof req.baseUrl === "string" ? req.baseUrl : "";
  return base + routePath;
}

/**
 * Records handler errors that reach Express's error chain (via next(err))
 * on the request span: err.message plus the stack — clipped to 8192
 * chars — under the "error.stack" attribute. Always hands the error on to
 * the next error handler (Express's default responder when none is
 * registered), so behavior is unchanged.
 */
export function errorMiddleware(): ExpressErrorMiddleware {
  return (err, req, _res, next) => {
    if (enabled()) {
      const span = (req as unknown as Record<symbol, Span | undefined>)[DATAFLOW_SPAN];
      if (span) {
        span.recordError(err);
        const stack = clipStack(err instanceof Error ? err.stack : undefined);
        if (stack) span.setAttr("error.stack", stack);
      }
    }
    next(err);
  };
}

export { TRACE_HEADER };
