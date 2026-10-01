import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import dataflow from "../src/index.js";
import { closeServer, listenOnce, parseBody, resetSdk, startCollector, type Collector } from "./helpers.js";
import type { EventWire } from "../src/types.js";

let collector: Collector;
let app: Express;
let server: Server;
let base: string;

async function startApp(a: Express): Promise<string> {
  app = a;
  server = createServer(a);
  const port = await listenOnce(server);
  return `http://127.0.0.1:${port}`;
}

function serverSpans(): EventWire[] {
  const out: EventWire[] = [];
  for (const r of collector.requests) {
    if (r.path !== "/api/v1/ingest") continue;
    for (const ev of parseBody(r).events as EventWire[]) {
      if (ev.type === "HTTP_SERVER") out.push(ev);
    }
  }
  return out;
}

async function waitForSpans(n: number): Promise<EventWire[]> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const spans = serverSpans();
    if (spans.length >= n) return spans;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${n} server spans (got ${spans.length})`);
    await new Promise((r) => setTimeout(r, 25));
  }
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

describe("express middleware", () => {
  it("names spans after the route template and records status", async () => {
    app = express();
    app.use(dataflow.middleware());
    app.get("/users/:id", (_req, res) => {
      res.json({ id: 1 });
    });
    app.use(dataflow.errorMiddleware());
    base = await startApp(app);

    const resp = await fetch(`${base}/users/42`, {
      headers: { "x-custom-header": "hello", "x-api-key": "super-secret" },
    });
    expect(resp.status).toBe(200);
    // Response carries the trace id so downstream services join:
    const traceId = resp.headers.get("x-dataflow-trace-id");
    expect(traceId).toMatch(/^[0-9a-f]{16}$/);

    await dataflow.flushNow();
    const spans = await waitForSpans(1);
    const ev = spans[0]!;
    expect(ev.name).toBe("GET /users/:id");
    expect(ev.trace_id).toBe(traceId);
    expect(ev.status_code).toBe(200);
    expect(ev.error_message).toBe("");
    expect(ev.metadata["http.method"]).toBe("GET");
    expect(ev.metadata["http.path"]).toBe("/users/42");
    expect(ev.metadata["http.route"]).toBe("/users/:id");
    expect(ev.metadata["http.status_code"]).toBe("200");
    expect(ev.metadata["agent.sdk"]).toMatch(/^node-sdk\//);
    // headers captured, sensitive ones redacted (fleet REDACTED_HEADERS)
    expect(ev.metadata["http.header.x-custom-header"]).toBe("hello");
    expect(ev.metadata["http.header.x-api-key"]).toBe("[REDACTED]");
    expect(ev.metadata["http.header.authorization"]).toBeUndefined();
  });

  it("includes the mount prefix in the route name for nested routers", async () => {
    app = express();
    app.use(dataflow.middleware());
    const nested = express.Router();
    nested.get("/users/:id", (_req, res) => res.json({ ok: true }));
    app.use("/api/v1", nested);
    app.use(dataflow.errorMiddleware());
    base = await startApp(app);

    await fetch(`${base}/api/v1/users/7`);
    await dataflow.flushNow();
    const spans = await waitForSpans(1);
    expect(spans[0]!.name).toBe("GET /api/v1/users/:id");
    expect(spans[0]!.metadata["http.route"]).toBe("/api/v1/users/:id");
  });

  it("joins an incoming trace via x-dataflow-trace-id", async () => {
    app = express();
    app.use(dataflow.middleware());
    app.get("/join", (_req, res) => res.end("ok"));
    base = await startApp(app);

    const resp = await fetch(`${base}/join`, { headers: { "x-dataflow-trace-id": "abcdef0123456789" } });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-dataflow-trace-id")).toBe("abcdef0123456789");
    await dataflow.flushNow();
    const spans = await waitForSpans(1);
    expect(spans[0]!.trace_id).toBe("abcdef0123456789");
    expect(spans[0]!.parent_span_id).toBe(""); // join keeps the root's shape
  });

  it("records 4xx statuses without fabricating an error", async () => {
    app = express();
    app.use(dataflow.middleware());
    base = await startApp(app);

    const resp = await fetch(`${base}/nope`);
    expect(resp.status).toBe(404);
    await dataflow.flushNow();
    const spans = await waitForSpans(1);
    expect(spans[0]!.name).toBe("GET /nope"); // unmatched: raw path fallback
    expect(spans[0]!.status_code).toBe(404);
    expect(spans[0]!.error_message).toBe("");
  });

  it("captures handler errors via next(err): message + clipped error.stack", async () => {
    app = express();
    app.use(dataflow.middleware());
    app.get("/boom", () => {
      throw new Error("boom: explode");
    });
    app.use(dataflow.errorMiddleware());
    base = await startApp(app);

    const resp = await fetch(`${base}/boom`);
    expect(resp.status).toBe(500);
    await dataflow.flushNow();
    const spans = await waitForSpans(1);
    const ev = spans[0]!;
    expect(ev.name).toBe("GET /boom");
    expect(ev.status_code).toBe(500);
    // the specific error wins over the generic "http 500"
    expect(ev.error_message).toBe("boom: explode");
    const stack = ev.metadata["error.stack"];
    expect(stack).toContain("Error: boom: explode");
    expect(stack!.length).toBeLessThanOrEqual(8192);
  });

  it("records an explicit next(err) with an oversized stack clipped to 8192", async () => {
    app = express();
    app.use(dataflow.middleware());
    app.get("/longboom", (_req, _res, next) => {
      const err = new Error("long failure");
      err.stack = "E: " + "x".repeat(20000);
      next(err);
    });
    app.use(dataflow.errorMiddleware());
    base = await startApp(app);

    await fetch(`${base}/longboom`);
    await dataflow.flushNow();
    const spans = await waitForSpans(1);
    expect(spans[0]!.metadata["error.stack"]!.length).toBe(8192);
    expect(spans[0]!.error_message).toBe("long failure");
  });

  it("lets nested dataflow.trace calls join the request trace", async () => {
    app = express();
    app.use(dataflow.middleware());
    app.get("/flow", async (_req, res) => {
      await dataflow.trace("work.Step", (s) => {
        s.setData("k", "v");
      });
      res.end("done");
    });
    app.use(dataflow.errorMiddleware());
    base = await startApp(app);

    const resp = await fetch(`${base}/flow`);
    expect(resp.status).toBe(200);
    await dataflow.flushNow();

    const reqs = await collector.waitFor("/api/v1/ingest", 1);
    const events = parseBody(reqs[0]!).events as EventWire[];
    const serverEv = events.find((e) => e.type === "HTTP_SERVER")!;
    const child = events.find((e) => e.name === "work.Step")!;
    expect(child.trace_id).toBe(serverEv.trace_id);
    expect(child.parent_span_id).toBe(serverEv.span_id);
    expect(child.metadata["data.fields"]).toBe("k");
  });

  it("stays a no-op when the SDK is disabled", async () => {
    dataflow.configure({ disabled: true });
    app = express();
    app.use(dataflow.middleware());
    app.get("/plain", (_req, res) => res.end("ok"));
    base = await startApp(app);

    const resp = await fetch(`${base}/plain`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-dataflow-trace-id")).toBeNull();
    await dataflow.flushNow();
    expect(collector.requests).toHaveLength(0);
  });
});
