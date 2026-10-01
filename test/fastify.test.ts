import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import dataflow from "../src/index.js";
import { parseBody, resetSdk, startCollector, type Collector } from "./helpers.js";
import type { EventWire } from "../src/types.js";

let collector: Collector;
let app: FastifyInstance;

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
  await app?.close();
  await collector.close();
});

describe("fastify plugin", () => {
  it("names spans after the route template and records status", async () => {
    app = Fastify();
    app.register(dataflow.fastifyPlugin);
    app.get("/users/:id", async (_req, reply) => {
      reply.send({ id: 1 });
    });
    await app.ready();

    const resp = await app.inject({ method: "GET", url: "/users/42" });
    expect(resp.statusCode).toBe(200);
    expect(resp.headers["x-dataflow-trace-id"]).toMatch(/^[0-9a-f]{16}$/);

    await dataflow.flushNow();
    const spans = await waitForSpans(1);
    const ev = spans[0]!;
    expect(ev.name).toBe("GET /users/:id");
    expect(ev.trace_id).toBe(resp.headers["x-dataflow-trace-id"]);
    expect(ev.status_code).toBe(200);
    expect(ev.metadata["http.method"]).toBe("GET");
    expect(ev.metadata["http.path"]).toBe("/users/42");
    expect(ev.metadata["http.route"]).toBe("/users/:id");
    expect(ev.metadata["agent.sdk"]).toMatch(/^node-sdk\//);
  });

  it("joins an incoming trace and lets handler spans nest", async () => {
    app = Fastify();
    app.register(dataflow.fastifyPlugin);
    app.get("/flow", async () => {
      await dataflow.trace("work.Step", (s) => {
        s.setData("k", 1);
      });
      return "done";
    });
    await app.ready();

    const resp = await app.inject({ method: "GET", url: "/flow", headers: { "x-dataflow-trace-id": "fedcba9876543210" } });
    expect(resp.statusCode).toBe(200);
    await dataflow.flushNow();

    const reqs = await collector.waitFor("/api/v1/ingest", 1);
    const events = parseBody(reqs[0]!).events as EventWire[];
    const serverEv = events.find((e) => e.type === "HTTP_SERVER")!;
    const child = events.find((e) => e.name === "work.Step")!;
    expect(serverEv.trace_id).toBe("fedcba9876543210");
    expect(child.trace_id).toBe("fedcba9876543210");
    expect(child.parent_span_id).toBe(serverEv.span_id);
  });

  it("records handler errors via onError and the 5xx status", async () => {
    app = Fastify();
    app.register(dataflow.fastifyPlugin);
    app.get("/boom", async () => {
      throw new Error("fastify boom");
    });
    await app.ready();

    const resp = await app.inject({ method: "GET", url: "/boom" });
    expect(resp.statusCode).toBe(500);
    await dataflow.flushNow();
    const spans = await waitForSpans(1);
    const ev = spans[0]!;
    expect(ev.name).toBe("GET /boom");
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toBe("fastify boom"); // specific error wins over "http 500"
    expect(ev.metadata["error.stack"]).toContain("Error: fastify boom");
  });

  it("stays a no-op when the SDK is disabled", async () => {
    dataflow.configure({ disabled: true });
    app = Fastify();
    app.register(dataflow.fastifyPlugin);
    app.get("/plain", async () => "ok");
    await app.ready();

    const resp = await app.inject({ method: "GET", url: "/plain" });
    expect(resp.statusCode).toBe(200);
    expect(resp.headers["x-dataflow-trace-id"]).toBeUndefined();
    await dataflow.flushNow();
    expect(collector.requests).toHaveLength(0);
  });
});
