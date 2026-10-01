import type { Span } from "../span.js";
import type { DATAFLOW_SPAN } from "./spankey.js";

/**
 * Minimal structural types for the HTTP server integrations. The SDK has
 * zero runtime dependencies and zero dev-time framework coupling — express
 * and fastify appear only as devDependencies of the SDK's own test suite.
 */

export interface ServerRequestLike {
  method?: string;
  /** Raw request URL including query string ("/path?x=1"). */
  url?: string;
  /** Decoded path without the query string (express). */
  path?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null } | undefined;
  /** Framework route match, when already resolved. */
  route?: { path?: string } | undefined;
  /** Mount prefix of an enclosing router (express). */
  baseUrl?: string | undefined;
  /** Request-scoped bag for the active span (symbol-keyed). */
  [DATAFLOW_SPAN]?: Span | undefined;
}

export interface ServerResponseLike {
  statusCode: number;
  once(event: string, listener: () => void): unknown;
  setHeader(name: string, value: string): unknown;
}

export type NextFunction = (err?: unknown) => void;
