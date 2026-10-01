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
import type { DataflowOptions } from "./config.js";

/**
 * HuginnLabs Dataflow SDK for Node.js/TypeScript — runtime tracing with
 * E2E-encrypted payloads. Configure once, then trace anywhere:
 *
 *     import dataflow from "@huginnlabs/dataflow";
 *
 *     dataflow.configure({ apiKey: "df_...", endpoint: "https://ingest.example.com" });
 *     app.use(dataflow.middleware());          // express
 *     await dataflow.trace("payments.Charge", async (s) => {
 *       s.setData("order", order);
 *     });
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
};

export type { DataflowOptions } from "./config.js";
export type { EventType } from "./types.js";
