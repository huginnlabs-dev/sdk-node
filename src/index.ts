import { SDK_VERSION } from "./version.js";
import { configure, enabled, resolveHttpBase, settings } from "./config.js";
import { trace, span, startSpan } from "./trace.js";
import { Span } from "./span.js";
import { currentSpan } from "./context.js";
import { middleware, errorMiddleware } from "./middleware/express.js";
import { fastifyPlugin } from "./middleware/fastify.js";
import { instrumentServer } from "./middleware/http.js";
import { classifyPII } from "./pii.js";
import { ensureStarted, flushNow } from "./pipeline.js";
import { capture, captureUncaught, restoreCrash } from "./crash.js";
import { dbSpan, instrumentHttp, restoreHttp } from "./instrument.js";
import {
  captureConsole,
  debug,
  error,
  flushLogs,
  info,
  log,
  restoreConsole,
  warn,
} from "./logs.js";
import type { DataflowOptions } from "./config.js";

/**
 * HuginnLabs Dataflow SDK for Node.js/TypeScript — runtime tracing with
 * E2E-encrypted payloads. Configure once, then trace anywhere:
 *
 *     import dataflow from "@huginnlabs/dataflow";
 *
 *     dataflow.configure({ apiKey: "df_...", endpoint: "https://ingest.example.com" });
 *     app.use(dataflow.middleware());          // express
 *     dataflow.instrumentHttp();               // outgoing HTTP_CLIENT spans
 *     await dataflow.trace("payments.Charge", async (s) => {
 *       s.setData("order", order);
 *     });
 *
 * Crash evidence rides the same pipeline: dataflow.capture(fn) records an
 * error on the active span before re-throwing, and captureUncaught()
 * hooks uncaughtException/unhandledRejection. The dataflow-scan CLI ships
 * the static route catalog (POST /api/v1/catalog).
 *
 * Application logs ship alongside traces: dataflow.info("msg", {k: "v"})
 * records a line correlated with the current span's trace id, and
 * dataflow.captureConsole() mirrors console.* calls into the same log
 * stream (POST /api/v1/logs) — console output always stays untouched.
 *
 * Everything also configures from DATAFLOW_* environment variables.
 */
const dataflow = {
  SDK_VERSION,
  configure,
  enabled,
  settings,
  resolveHttpBase,
  trace,
  span,
  startSpan,
  currentSpan,
  Span,
  middleware,
  errorMiddleware,
  fastifyPlugin,
  instrumentServer,
  classifyPII,
  flushNow,
  instrumentHttp,
  restoreHttp,
  dbSpan,
  capture,
  captureUncaught,
  restoreCrash,
  debug,
  info,
  warn,
  error,
  log,
  flushLogs,
  captureConsole,
  restoreConsole,
};

export default dataflow;

export {
  SDK_VERSION,
  configure,
  enabled,
  resolveHttpBase,
  settings,
  trace,
  span,
  startSpan,
  currentSpan,
  Span,
  middleware,
  errorMiddleware,
  fastifyPlugin,
  instrumentServer,
  classifyPII,
  flushNow,
  ensureStarted,
  instrumentHttp,
  restoreHttp,
  dbSpan,
  capture,
  captureUncaught,
  restoreCrash,
  debug,
  info,
  warn,
  error,
  log,
  flushLogs,
  captureConsole,
  restoreConsole,
};

export type { DataflowOptions } from "./config.js";
export type { EventType } from "./types.js";
export type { LogWire } from "./types.js";
export type { LogLevel } from "./logs.js";
