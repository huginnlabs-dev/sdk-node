import { enabled } from "../config.js";
import { enterSpanContext } from "../context.js";
import { Span } from "../span.js";
import {
  clipStack,
  finishServerSpan,
  pathOnly,
  setTraceHeader,
  startServerSpan,
} from "./shared.js";
import { DATAFLOW_SPAN } from "./spankey.js";

/**
 * Fastify plugin (fastify v3/v4/v5). Register with:
 *
 *     app.register(dataflow.fastifyPlugin);
 *
 * onRequest opens the HTTP_SERVER span (and binds it as the async context,
 * so handlers and hooks join the request trace), onResponse closes it with
 * the final status and route template ("GET /users/:id" via
 * request.routeOptions.url, with fallbacks for older fastify), onError
 * records handler errors.
 */

interface FastifyLikeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null };
  // fastify v4/v5
  routeOptions?: { url?: string };
  // fastify v3
  routerPath?: string;
  [DATAFLOW_SPAN]?: Span;
}

interface FastifyLikeReply {
  statusCode: number;
  header(name: string, value: string): unknown;
}

interface FastifyLikeInstance {
  addHook(name: string, hook: (...args: never[]) => void): unknown;
}

export interface FastifyPluginOptions {
  [key: string]: unknown;
}

type Done = (err?: Error) => void;

export function fastifyPlugin(
  instance: FastifyLikeInstance,
  _opts: FastifyPluginOptions,
  done: Done,
): void {
  instance.addHook("onRequest", ((request: FastifyLikeRequest, reply: FastifyLikeReply, hookDone: Done) => {
    if (!enabled()) {
      hookDone();
      return;
    }
    const method = (request.method ?? "GET").toUpperCase();
    const rawPath = pathOnly(request.url);
    const span = startServerSpan({
      method,
      rawPath,
      headers: request.headers,
      remoteAddr: request.socket?.remoteAddress ?? null,
    });
    request[DATAFLOW_SPAN] = span;
    setTraceHeader((name, value) => reply.header(name, value), span.traceId);
    // Bind the rest of the fastify lifecycle (handler included) to the span.
    enterSpanContext(span);
    hookDone();
  }) as never);

  instance.addHook("onError", ((request: FastifyLikeRequest, _reply: FastifyLikeReply, err: Error, hookDone: Done) => {
    const span = request[DATAFLOW_SPAN];
    if (span) {
      span.recordError(err);
      const stack = clipStack(err.stack);
      if (stack) span.setAttr("error.stack", stack);
    }
    hookDone();
  }) as never);

  instance.addHook("onResponse", ((request: FastifyLikeRequest, reply: FastifyLikeReply, hookDone: Done) => {
    const span = request[DATAFLOW_SPAN];
    if (span) {
      const method = (request.method ?? "GET").toUpperCase();
      finishServerSpan({
        span,
        method,
        status: reply.statusCode,
        routeTemplate: routeTemplate(request),
      });
    }
    hookDone();
  }) as never);

  done();
}

// fastify's fp convention: a plugin without encapsulation needs — safe to
// register repeatedly, applies globally.
(fastifyPlugin as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;

function routeTemplate(request: FastifyLikeRequest): string | null {
  const url = request.routeOptions?.url ?? request.routerPath;
  return typeof url === "string" && url !== "" ? url : null;
}
