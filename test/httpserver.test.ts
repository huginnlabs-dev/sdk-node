import { createServer, type RequestListener, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import dataflow from "../src/index.js";
import { closeServer, listenOnce, parseBody, resetSdk, startCollector, type Collector } from "./helpers.js";
import type { EventWire } from "../src/types.js";

let collector: Collector;
let server: Server;
let base: string;

async function startServer(handler: RequestListener, trackSockets = false): Promise<string> {
  server = createServer(handler);
  const sockets = new Set<Socket>();
  if (trackSockets) {
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    (server as Server & { __sockets?: Set<Socket> }).__sockets = sockets;
  }
  const port = await listenOnce(server);
  return `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  collector = await startCollector();
  resetSdk();
  dataflow.configure({ apiKey: "df_test_key", endpoint: collector.url });
});

afterEach(async () => {
  await closeServer(server);
  await collector.close();
});

describe("instrumentServer (plain node:http)", () => {
  it("wraps handlers with HTTP_SERVER spans named METHOD + raw path", async () => {
    const handler: RequestListener = (req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, method: req.method }));
    };
    base = await startServer(dataflow.instrumentServer(handler));

    const resp = await fetch(`${base}/items/3?limit=1`);
    expect(resp.status).toBe(200);
    const traceId = resp.headers.get("x-dataflow-trace-id");
    expect(traceId).toMatch(/^[0-9a-f]{16}$/);

    await dataflow.flushNow();
    const reqs = await collector.waitFor("/api/v1/ingest", 1);
    const events = parseBody(reqs[0]!).events as EventWire[];
    const ev = events.find((e) => e.type === "HTTP_SERVER")!;
    expect(ev.name).toBe("GET /items/3"); // query string stripped
    expect(ev.status_code).toBe(200);
    expect(ev.metadata["http.path"]).toBe("/items/3");
    expect(ev.trace_id).toBe(traceId);
  });

  it("records sync handler throws on the span and re-raises", async () => {
    const handler: RequestListener = () => {
      throw new Error("handler exploded");
    };
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      uncaught.push(err);
    };
    process.on("uncaughtException", onUncaught);
    base = await startServer(dataflow.instrumentServer(handler), true);

    // The connection dies mid-request (no response is ever written); bound
    // the fetch so the test cannot hang on a half-open socket.
    await fetch(`${base}/crash`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
    const sockets = (server as Server & { __sockets?: Set<Socket> }).__sockets;
    for (const s of sockets ?? []) s.destroy();
    await dataflow.flushNow();
    const reqs = await collector.waitFor("/api/v1/ingest", 1);
    const events = parseBody(reqs[0]!).events as EventWire[];
    const ev = events.find((e) => e.type === "HTTP_SERVER")!;
    expect(ev.error_message).toBe("handler exploded");
    process.off("uncaughtException", onUncaught);
    expect(uncaught.length).toBeGreaterThan(0);
  });

  it("passes through untouched when the SDK is disabled", async () => {
    dataflow.configure({ disabled: true });
    base = await startServer(
      dataflow.instrumentServer((_req, res) => res.end("ok")),
    );

    const resp = await fetch(`${base}/plain`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-dataflow-trace-id")).toBeNull();
    await dataflow.flushNow();
    expect(collector.requests).toHaveLength(0);
  });
});
