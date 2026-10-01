import type { IncomingMessage, ServerResponse } from "node:http";

import { enabled } from "../config.js";
import { runWithSpan } from "../context.js";
import {
  finishServerSpan,
  pathOnly,
  setTraceHeader,
  startServerSpan,
} from "./shared.js";
import { DATAFLOW_SPAN } from "./spankey.js";

/**
 * Generic wrapper for plain node:http servers (and anything speaking the
 * (req, res) contract — connect, polka, restana):
 *
 *     const server = http.createServer(dataflow.instrumentServer(handler));
 *
 * Spans are HTTP_SERVER, named "METHOD <raw path>" (no router is involved,
 * so no route template is available).
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export function instrumentServer(handler: Handler): Handler {
  return (req, res) => {
    if (!enabled()) {
      handler(req, res);
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    const rawPath = pathOnly(req.url);
    const span = startServerSpan({
      method,
      rawPath,
      headers: req.headers,
      remoteAddr: req.socket?.remoteAddress ?? null,
    });
    (req as IncomingMessage & { [DATAFLOW_SPAN]?: unknown })[DATAFLOW_SPAN] = span;
    setTraceHeader((name, value) => res.setHeader(name, value), span.traceId);

    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      finishServerSpan({ span, method, status: res.statusCode });
    };
    res.once("finish", finish);
    res.once("close", finish);

    try {
      // Sync throws from the handler are recorded on the span, then
      // re-raised exactly as they would be without the SDK.
      runWithSpan(span, () => handler(req, res));
    } catch (err) {
      span.recordError(err);
      span.end();
      throw err;
    }
  };
}
