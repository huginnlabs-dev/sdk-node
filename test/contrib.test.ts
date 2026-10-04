import { createServer, type RequestListener, type Server } from "node:http";
import { Writable } from "node:stream";

import axios from "axios";
import express from "express";
import Koa from "koa";
import pino from "pino";
import winston from "winston";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  instrumentAxios,
  instrumentHttpServer,
  instrumentKoa,
  instrumentMongoose,
  instrumentMysql,
  instrumentNest,
  instrumentPg,
  instrumentPino,
  instrumentWinston,
  restoreAxios,
  restoreKoa,
  restoreMongoose,
  restoreMysql,
  restoreNest,
  restorePg,
  restorePino,
  restoreWinston,
  traced,
  Traced,
} from "../src/contrib.js";
import { _resetForTests, configure } from "../src/config.js";
import { _resetLogsForTests, _setLogsSinkForTests } from "../src/logs.js";
import { _setSinkForTests, _resetForTests as resetPipeline, flushNow } from "../src/pipeline.js";
import { flushLogs } from "../src/logs.js";
import { trace } from "../src/trace.js";
import type { EventWire, LogWire } from "../src/types.js";
import { bodyText, closeServer, listenOnce, parseBody, resetSdk, startCollector, type Collector } from "./helpers.js";

let events: EventWire[] = [];
let lines: LogWire[] = [];
let collector: Collector | undefined;
let target: Collector | undefined;
let server: Server | undefined;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetSdk();
  events = [];
  lines = [];
  _setSinkForTests((ev) => events.push(ev));
  _setLogsSinkForTests((batch) => lines.push(...batch));
  configure({ apiKey: "df_test_key", endpoint: "http://127.0.0.1:9", serviceName: "contrib-svc" });
});

afterEach(async () => {
  restorePg();
  restoreMysql();
  restoreKoa();
  restoreNest();
  restoreAxios();
  restoreMongoose();
  restorePino();
  restoreWinston();
  _setLogsSinkForTests(null);
  _setSinkForTests(null);
  _resetLogsForTests();
  resetPipeline();
  _resetForTests();
  await collector?.close();
  collector = undefined;
  await target?.close();
  target = undefined;
  await closeServer(server);
  server = undefined;
});

// Duck-typed driver stubs: anything with query()/execute() on the
// prototype is exactly the surface the wrappers operate on.

class StubPg {
  calls: unknown[][] = [];
  async query(...args: unknown[]): Promise<{ rows: unknown[] }> {
    this.calls.push(args);
    return { rows: [{ id: 1 }] };
  }
}

class ThrowingPg {
  query(..._args: unknown[]): never {
    throw new Error("sync boom");
  }
}

class RejectingPg {
  async query(..._args: unknown[]): Promise<never> {
    throw new Error("async boom");
  }
}

type QueryCb = (err: Error | null, res: unknown) => void;

class CallbackPg {
  lastCbErr: unknown = null;
  query(sql: string, ...rest: unknown[]): { originalReturn: boolean } {
    void sql;
    const cb = rest[rest.length - 1];
    if (typeof cb === "function") {
      const invoked = (cb as QueryCb)(this.lastCbErr as Error | null, { rows: [] });
      void invoked;
      return { originalReturn: true };
    }
    return { originalReturn: true };
  }
}

class StubMysql {
  calls: string[] = [];
  async query(sql: string, ..._rest: unknown[]): Promise<unknown> {
    this.calls.push(sql);
    return [];
  }
  async execute(sql: string, ..._rest: unknown[]): Promise<unknown> {
    this.calls.push(sql);
    return [];
  }
}

describe("instrumentPg", () => {
  it("emits a DB_QUERY span named after the statement summary", async () => {
    const pool = new StubPg();
    instrumentPg(pool);
    const out = await pool.query("SELECT id, total FROM orders WHERE id = $1", [42]);
    expect(out).toEqual({ rows: [{ id: 1 }] });

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("DB_QUERY");
    expect(ev.name).toBe("SELECT orders");
    expect(ev.callee_package).toBe("postgres");
    expect(ev.metadata["db.system"]).toBe("postgres");
    expect(ev.metadata["db.statement"]).toBe("SELECT id, total FROM orders WHERE id = $1");
    expect(ev.status_code).toBe(200);
    expect(ev.error_message).toBe("");
    expect(ev.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("never captures bind values, and reads {text, values} config objects", async () => {
    const pool = new StubPg();
    instrumentPg(pool);
    await pool.query({ text: "INSERT INTO users (name) VALUES ($1)", values: ["secret-value"] });
    await pool.query("SELECT   *\n  FROM logs WHERE payload = 'literal'", []);

    const insert = events[0]!;
    expect(insert.name).toBe("INSERT users");
    expect(insert.metadata["db.statement"]).toBe("INSERT INTO users (name) VALUES ($1)");
    expect(JSON.stringify(insert.metadata)).not.toContain("secret-value");

    const select = events[1]!;
    expect(select.name).toBe("SELECT logs");
    expect(select.metadata["db.statement"]).not.toContain("\n");
  });

  it("reports schema-qualified tables as the bare table", async () => {
    const pool = new StubPg();
    instrumentPg(pool);
    await pool.query("UPDATE public.items SET total = total - 1 WHERE id = $1", [7]);
    expect(events[0]!.name).toBe("UPDATE items");
  });

  it("records a rejected query with status 500, clipped stack, and re-throws", async () => {
    const pool = new RejectingPg();
    instrumentPg(pool);
    await expect(pool.query("DELETE FROM sessions")).rejects.toThrow("async boom");

    const ev = events[0]!;
    expect(ev.type).toBe("DB_QUERY");
    expect(ev.name).toBe("DELETE sessions");
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toBe("async boom");
    const stack = ev.metadata["error.stack"];
    expect(stack).toBeTruthy();
    expect(stack!.length).toBeLessThanOrEqual(8192);
    expect(stack).toContain("async boom");
  });

  it("records a sync throw with status 500 and re-throws", () => {
    const pool = new ThrowingPg();
    instrumentPg(pool);
    expect(() => pool.query("SELECT 1")).toThrow("sync boom");
    expect(events[0]!.status_code).toBe(500);
    expect(events[0]!.error_message).toBe("sync boom");
  });

  it("supports callback style: span closes with the callback's outcome, return value untouched", async () => {
    const client = new CallbackPg();
    instrumentPg(client);

    let cbErr: unknown = null;
    const returned = client.query("SELECT 1", (err: unknown, res: unknown) => {
      cbErr = err;
      void res;
    });
    expect(returned).toEqual({ originalReturn: true }); // passthrough identity
    expect(cbErr).toBeNull();
    await sleep(1);
    expect(events[0]!.status_code).toBe(200);
    expect(events).toHaveLength(1); // callback style: no double span

    events.length = 0;
    client.lastCbErr = new Error("cb boom");
    client.query("SELECT 1", () => {});
    await sleep(1);
    expect(events[0]!.status_code).toBe(500);
    expect(events[0]!.error_message).toBe("cb boom");
  });

  it("nests under the active trace", async () => {
    const pool = new StubPg();
    instrumentPg(pool);
    await trace("app.Work", async () => {
      await pool.query("SELECT * FROM users");
    });
    expect(events).toHaveLength(2);
    const parent = events.find((e) => e.name === "app.Work")!;
    const child = events.find((e) => e.type === "DB_QUERY")!;
    expect(child.trace_id).toBe(parent.trace_id);
    expect(child.parent_span_id).toBe(parent.span_id);
  });

  it("is idempotent and restorePg() restores the original by identity", async () => {
    const pool = new StubPg();
    const original = pool.query;
    instrumentPg(pool);
    const wrapped = pool.query;
    instrumentPg(pool);
    expect(pool.query).toBe(wrapped); // second install is a no-op
    expect(wrapped).not.toBe(original);

    await pool.query("SELECT * FROM orders");
    expect(events.filter((e) => e.type === "DB_QUERY")).toHaveLength(1);

    restorePg();
    expect(pool.query).toBe(original);
    await pool.query("SELECT * FROM orders");
    expect(events.filter((e) => e.type === "DB_QUERY")).toHaveLength(1);
  });

  it("passes through untouched when the SDK is disabled", async () => {
    configure({ disabled: true });
    const pool = new StubPg();
    instrumentPg(pool);
    await pool.query("SELECT * FROM orders");
    expect(events).toHaveLength(0);
  });
});

describe("instrumentMysql", () => {
  it("wraps both query() and execute() with db.system mysql", async () => {
    const pool = new StubMysql();
    instrumentMysql(pool);
    await pool.query("INSERT INTO shipments (id) VALUES (?)", [3]);
    await pool.execute("SELECT * FROM shipments WHERE id = ?", [3]);

    expect(events).toHaveLength(2);
    const q = events[0]!;
    const e = events[1]!;
    expect(q.name).toBe("INSERT shipments");
    expect(q.metadata["db.system"]).toBe("mysql");
    expect(q.metadata["db.statement"]).toBe("INSERT INTO shipments (id) VALUES (?)");
    expect(JSON.stringify(q.metadata)).not.toContain("3"); // no bind values
    expect(e.name).toBe("SELECT shipments");
    expect(e.status_code).toBe(200);
    expect(e.callee_package).toBe("mysql");
  });

  it("records errors and restores the originals", async () => {
    const failing = {
      async query(_sql: string): Promise<never> {
        throw new Error("mysql down");
      },
    };
    const originalQuery = failing.query;
    instrumentMysql(failing);
    await expect(failing.query("SELECT 1")).rejects.toThrow("mysql down");
    expect(events[0]!.status_code).toBe(500);
    expect(events[0]!.metadata["db.system"]).toBe("mysql");

    restoreMysql();
    expect(failing.query).toBe(originalQuery);
    const count = events.length;
    await failing.query("SELECT 1").catch(() => {});
    expect(events).toHaveLength(count);
  });

  it("is idempotent", () => {
    const pool = new StubMysql();
    instrumentMysql(pool);
    const wrappedQuery = pool.query;
    const wrappedExecute = pool.execute;
    instrumentMysql(pool);
    expect(pool.query).toBe(wrappedQuery);
    expect(pool.execute).toBe(wrappedExecute);
  });
});

function captureStream(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, chunks };
}

describe("instrumentPino", () => {
  it("forwards output AND records the line via the log pipeline", async () => {
    const { stream, chunks } = captureStream();
    const logger = pino(stream);
    const originalInfo = logger.info;
    instrumentPino(logger);

    logger.info({ order: 7 }, "order shipped");
    await sleep(10);
    await flushLogs();

    expect(chunks).toHaveLength(1); // output forwarded exactly once
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.level).toBe("info");
    expect(line.message).toContain("order shipped");
    expect(line.service_name).toBe("contrib-svc");

    restorePino();
    expect(logger.info).toBe(originalInfo);
  });

  it("maps fatal to error and keeps debug at debug", async () => {
    const { stream } = captureStream();
    const logger = pino({ level: "debug" }, stream);
    instrumentPino(logger);

    logger.fatal("disk on fire");
    logger.debug("cache miss");
    await sleep(10);
    await flushLogs();

    expect(lines.map((l) => l.level)).toEqual(["error", "debug"]);
    expect(lines[0]!.message).toContain("disk on fire");
  });

  it("carries the current span's trace ids and is idempotent", async () => {
    const { stream } = captureStream();
    const logger = pino(stream);
    instrumentPino(logger);
    const wrappedInfo = logger.info;
    instrumentPino(logger);
    expect(logger.info).toBe(wrappedInfo);

    await trace("app.Reserve", async () => {
      logger.warn("running low");
    });
    await sleep(10);
    await flushLogs();
    expect(lines).toHaveLength(1); // one call -> one line, even after re-install
    expect(lines[0]!.trace_id).not.toBe("");
    expect(lines[0]!.level).toBe("warn");
  });

  it("still forwards output while the SDK is disabled, recording nothing", async () => {
    configure({ disabled: true });
    const { stream, chunks } = captureStream();
    const logger = pino(stream);
    instrumentPino(logger);

    logger.error("still printed");
    await sleep(10);
    await flushLogs();

    expect(chunks).toHaveLength(1);
    expect(lines).toHaveLength(0);
  });
});

describe("instrumentWinston", () => {
  function makeLogger(): { logger: winston.Logger; chunks: string[] } {
    const { stream, chunks } = captureStream();
    const logger = winston.createLogger({
      level: "silly",
      transports: [new winston.transports.Stream({ stream })],
    });
    return { logger, chunks };
  }

  it("forwards to transports AND records info/warn/error", async () => {
    const { logger, chunks } = makeLogger();
    instrumentWinston(logger);

    logger.info("via winston");
    logger.warn("careful");
    logger.error("bad");
    await sleep(10);
    await flushLogs();

    expect(chunks).toHaveLength(3); // transports saw everything
    expect(lines.map((l) => l.level)).toEqual(["info", "warn", "error"]);
    expect(lines[0]!.message).toBe("via winston");
    expect(lines[2]!.message).toBe("bad");
  });

  it("maps unknown levels (http) to debug and is idempotent", async () => {
    const { logger } = makeLogger();
    instrumentWinston(logger);
    const wrappedWrite = logger.write;
    instrumentWinston(logger);
    expect(logger.write).toBe(wrappedWrite);

    logger.http("health probe");
    await sleep(10);
    await flushLogs();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("debug");
  });

  it("restores write() by identity", async () => {
    const { logger } = makeLogger();
    const originalWrite = logger.write;
    instrumentWinston(logger);
    expect(logger.write).not.toBe(originalWrite);
    restoreWinston();
    expect(logger.write).toBe(originalWrite);

    const count = lines.length;
    logger.info("after restore");
    await sleep(10);
    await flushLogs();
    expect(lines).toHaveLength(count);
  });

  it("still writes to transports while the SDK is disabled", async () => {
    configure({ disabled: true });
    const { logger, chunks } = makeLogger();
    instrumentWinston(logger);

    logger.info("quiet record");
    await sleep(10);
    await flushLogs();
    expect(chunks).toHaveLength(1);
    expect(lines).toHaveLength(0);
  });
});

describe("traced / Traced decorator", () => {
  // esbuild (vite 8) no longer lowers stage-3 decorators, so the suite
  // applies the decorator's returned wrapper manually — the exact runtime
  // contract `@Traced()` compiles down to.
  class Payments {
    fee = 3;

    charge = Traced()(
      function (this: Payments, x: number): number {
        return x + this.fee;
      },
      { name: "charge", private: false },
    ) as (x: number) => number;

    fail = Traced({ name: "custom.Name" })(
      async function (this: Payments): Promise<never> {
        throw new Error("declined");
      },
      { name: "fail", private: false },
    ) as () => Promise<never>;
  }

  it("wraps a sync method, preserving this and the return value", () => {
    const payments = new Payments();
    const out = payments.charge(4);
    expect(out).toBe(7);

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("FUNCTION_CALL");
    expect(ev.name).toBe("charge");
    expect(ev.status_code).toBe(200);
  });

  it("records async failures with status 500 + error.stack and re-throws", async () => {
    const payments = new Payments();
    await expect(payments.fail()).rejects.toThrow("declined");

    const ev = events[0]!;
    expect(ev.type).toBe("FUNCTION_CALL");
    expect(ev.name).toBe("custom.Name");
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toBe("declined");
    const stack = ev.metadata["error.stack"];
    expect(stack).toBeTruthy();
    expect(stack!.length).toBeLessThanOrEqual(8192);
  });

  it("nests under the active trace as a child", async () => {
    await trace("outer.Op", () => new Payments().charge(1));
    expect(events).toHaveLength(2);
    const parent = events.find((e) => e.name === "outer.Op")!;
    const child = events.find((e) => e.name === "charge")!;
    expect(child.trace_id).toBe(parent.trace_id);
    expect(child.parent_span_id).toBe(parent.span_id);
  });

  it("traced() passes the span, the value and the error through", async () => {
    const out = await traced("app.Compute", (span) => {
      span.setAttr("mode", "fast");
      return 41 + 1;
    });
    expect(out).toBe(42);
    expect(events[0]!.name).toBe("app.Compute");
    expect(events[0]!.status_code).toBe(200);
    expect(events[0]!.metadata["mode"]).toBe("fast");

    await expect(
      traced("app.Compute", async () => {
        throw new Error("compute failed");
      }),
    ).rejects.toThrow("compute failed");
    const ev = events[1]!;
    expect(ev.status_code).toBe(500);
    expect(ev.metadata["error.stack"]).toBeTruthy();
  });
});

describe("wire shapes to the collector", () => {
  it("POSTs DB_QUERY events to /api/v1/ingest and logger lines to /api/v1/logs", async () => {
    collector = await startCollector();
    // Route deliveries to the real collector instead of the test sinks.
    _setSinkForTests(null);
    _setLogsSinkForTests(null);
    configure({ apiKey: "df_test_key", endpoint: collector.url, serviceName: "wire-svc" });

    const pool = new StubPg();
    instrumentPg(pool);
    await pool.query("SELECT * FROM orders");

    const { stream } = captureStream();
    const logger = pino(stream);
    instrumentPino(logger);
    logger.error("wire error");

    await flushNow();
    await flushLogs();

    const ingests = await collector.waitFor("/api/v1/ingest");
    const batch = parseBody(ingests[0]!) as { events: EventWire[] };
    const dbEvents = batch.events.filter((e) => e.type === "DB_QUERY");
    expect(dbEvents).toHaveLength(1);
    expect(dbEvents[0]!.name).toBe("SELECT orders");
    expect(dbEvents[0]!.metadata["db.system"]).toBe("postgres");
    expect(dbEvents[0]!.service_name).toBe("wire-svc");

    const logPosts = await collector.waitFor("/api/v1/logs");
    const logBatch = JSON.parse(bodyText(logPosts[0]!)) as { logs: LogWire[] };
    expect(logBatch.logs).toHaveLength(1);
    expect(logBatch.logs[0]!.level).toBe("error");
    expect(logBatch.logs[0]!.message).toContain("wire error");
    expect(logBatch.logs[0]!.service_name).toBe("wire-svc");
  });

  it("ships HTTP_CLIENT and mongodb DB_QUERY wire shapes", async () => {
    collector = await startCollector(); // delivery endpoint
    const tgt = await startCollector(); // axios destination (not the SDK's endpoint)
    target = tgt;
    _setSinkForTests(null);
    _setLogsSinkForTests(null);
    configure({ apiKey: "df_test_key", endpoint: collector.url, serviceName: "wire-svc" });

    const conn = new FakeConnection();
    instrumentMongoose(conn);
    const User = conn.model("User", new FakeSchema()) as typeof FakeModelBase;
    await User.find();

    const instance = axios.create();
    instrumentAxios(instance);
    await trace("outer.Wire", async () => {
      await instance.get(`${tgt.url}/orders`);
    });

    await flushNow();
    const ingests = await collector.waitFor("/api/v1/ingest");
    const batch: EventWire[] = [];
    for (const req of ingests) {
      batch.push(...(parseBody(req).events as EventWire[]));
    }

    const mongo = batch.find((e) => e.type === "DB_QUERY" && e.metadata["db.system"] === "mongodb")!;
    expect(mongo.name).toBe("FIND User");
    expect(mongo.callee_package).toBe("mongodb");
    expect(mongo.service_name).toBe("wire-svc");
    expect(mongo.status_code).toBe(200);

    const parent = batch.find((e) => e.name === "outer.Wire")!;
    const http = batch.find((e) => e.type === "HTTP_CLIENT")!;
    expect(http.name).toBe(`GET 127.0.0.1:${target.port}/orders`);
    expect(http.metadata["http.method"]).toBe("GET");
    expect(http.metadata["http.url"]).toBe(`${target.url}/orders`);
    expect(http.callee_package).toBe(`127.0.0.1:${target.port}`);
    expect(http.status_code).toBe(200);
    expect(http.trace_id).toBe(parent.trace_id);
    expect(http.parent_span_id).toBe(parent.span_id);
  });
});

// ---------------------------------------------------------------------------
// instrumentKoa
// ---------------------------------------------------------------------------

function makeKoaApp(): Koa {
  const app = new Koa();
  app.on("error", () => {}); // silence default stderr logging in the throw test
  return app;
}

/** Drains until n HTTP_SERVER spans landed in the test sink. */
async function waitForServerSpans(n: number): Promise<EventWire[]> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const spans = events.filter((e) => e.type === "HTTP_SERVER");
    if (spans.length >= n) return spans;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${n} server spans (got ${spans.length})`);
    }
    await sleep(25);
  }
}

async function startHttpServer(listener: RequestListener): Promise<string> {
  server = createServer(listener);
  const port = await listenOnce(server);
  return `http://127.0.0.1:${port}`;
}

describe("instrumentKoa", () => {
  it("emits HTTP_SERVER spans, propagates the trace header, and nests downstream work", async () => {
    const app = makeKoaApp();
    const remove = instrumentKoa(app);
    expect(typeof remove).toBe("function");
    app.use(async (ctx) => {
      await trace("koa.Work", async () => {
        ctx.body = { ok: true };
      });
    });
    const base = await startHttpServer(app.callback());

    const resp = await fetch(`${base}/things/7?limit=2`);
    expect(resp.status).toBe(200);
    const traceId = resp.headers.get("x-dataflow-trace-id");
    expect(traceId).toMatch(/^[0-9a-f]{16}$/);

    const spans = await waitForServerSpans(1);
    const ev = spans[0]!;
    expect(ev.name).toBe("GET /things/7"); // query string stripped, no router yet
    expect(ev.trace_id).toBe(traceId);
    expect(ev.status_code).toBe(200);
    expect(ev.error_message).toBe("");
    expect(ev.metadata["http.method"]).toBe("GET");
    expect(ev.metadata["http.path"]).toBe("/things/7");

    // Handlers ran inside the request trace.
    const kid = events.find((e) => e.name === "koa.Work")!;
    expect(kid.trace_id).toBe(ev.trace_id);
    expect(kid.parent_span_id).toBe(ev.span_id);
  });

  it("renames the span to the route template koa-router reports (ctx._matchedRoute)", async () => {
    const app = makeKoaApp();
    instrumentKoa(app);
    app.use(async (ctx, next) => {
      // what @koa/router's middleware does before dispatching to handlers
      (ctx as unknown as { _matchedRoute?: string })._matchedRoute = "/things/:id";
      await next();
    });
    app.use(async (ctx) => {
      ctx.body = { ok: true };
    });
    const base = await startHttpServer(app.callback());

    const resp = await fetch(`${base}/things/9`);
    expect(resp.status).toBe(200);
    const spans = await waitForServerSpans(1);
    expect(spans[0]!.name).toBe("GET /things/:id");
    expect(spans[0]!.metadata["http.route"]).toBe("/things/:id");
  });

  it("records downstream throws with status 500 + error.stack and still answers 500", async () => {
    const app = makeKoaApp();
    instrumentKoa(app);
    app.use(async () => {
      throw new Error("koa boom");
    });
    const base = await startHttpServer(app.callback());

    const resp = await fetch(`${base}/boom`);
    expect(resp.status).toBe(500);
    const spans = await waitForServerSpans(1);
    expect(spans[0]!.status_code).toBe(500);
    expect(spans[0]!.error_message).toBe("koa boom");
    const stack = spans[0]!.metadata["error.stack"];
    expect(stack).toBeTruthy();
    expect(stack!.length).toBeLessThanOrEqual(8192);
  });

  it("is idempotent per app and the remover splices the middleware back out", async () => {
    const app = makeKoaApp();
    const remove = instrumentKoa(app);
    const size = (app as unknown as { middleware: unknown[] }).middleware.length;
    instrumentKoa(app);
    expect((app as unknown as { middleware: unknown[] }).middleware.length).toBe(size);

    app.use(async (ctx) => {
      ctx.body = "ok";
    });
    const base = await startHttpServer(app.callback());

    await fetch(`${base}/one`);
    expect(await waitForServerSpans(1)).toHaveLength(1);

    remove();
    await fetch(`${base}/two`);
    await sleep(50);
    expect(events.filter((e) => e.type === "HTTP_SERVER")).toHaveLength(1);
  });

  it("passes through untouched when the SDK is disabled", async () => {
    configure({ disabled: true });
    const app = makeKoaApp();
    instrumentKoa(app);
    app.use(async (ctx) => {
      ctx.body = "ok";
    });
    const base = await startHttpServer(app.callback());

    const resp = await fetch(`${base}/plain`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-dataflow-trace-id")).toBeNull();
    await sleep(50);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// instrumentNest / instrumentHttpServer
// ---------------------------------------------------------------------------

describe("instrumentNest", () => {
  it("mounts the express chain on the adapter's express instance (documented path)", async () => {
    const expressApp = express();
    instrumentNest({ getHttpAdapter: () => ({ getInstance: () => expressApp }) });
    expressApp.get("/orders/:id", (_req, res) => {
      res.json({ ok: true });
    });
    const base = await startHttpServer(expressApp);

    const resp = await fetch(`${base}/orders/5`);
    expect(resp.status).toBe(200);
    const spans = await waitForServerSpans(1);
    expect(spans[0]!.name).toBe("GET /orders/:id"); // real route template
    expect(spans[0]!.metadata["http.route"]).toBe("/orders/:id");
    expect(spans[0]!.status_code).toBe(200);
  });

  it("does not stack middleware when called twice (idempotent)", () => {
    const uses: unknown[] = [];
    const expressLike = {
      use: (fn: unknown) => {
        uses.push(fn);
      },
    };
    const adapter = { getInstance: () => expressLike };
    instrumentNest({ getHttpAdapter: () => adapter });
    instrumentNest({ getHttpAdapter: () => adapter });
    expect(uses).toHaveLength(1);
  });

  it("falls back to the underlying http server when no express instance is reachable", async () => {
    server = createServer((_req, res) => {
      res.end("fallback");
    });
    instrumentNest({ getHttpServer: () => server });
    const port = await listenOnce(server);
    const base = `http://127.0.0.1:${port}`;

    const resp = await fetch(`${base}/fastify-ish`);
    expect(resp.status).toBe(200);
    const spans = await waitForServerSpans(1);
    expect(spans[0]!.type).toBe("HTTP_SERVER");
    expect(spans[0]!.name).toBe("GET /fastify-ish");
  });

  it("never throws on unreachable adapter shapes", () => {
    expect(() => instrumentNest({})).not.toThrow();
    expect(() => instrumentNest({ getHttpAdapter: () => ({ getInstance: () => ({}) }) })).not.toThrow();
    expect(() => instrumentNest({ getHttpServer: () => ({ listeners: () => [] }) })).not.toThrow();
    expect(() => instrumentNest({ getHttpServer: () => null })).not.toThrow();
  });
});

describe("instrumentHttpServer", () => {
  it("wraps request listeners with HTTP_SERVER spans and the remover restores them", async () => {
    server = createServer((_req, res) => {
      res.end("plain");
    });
    const remove = instrumentHttpServer(server);
    expect(typeof remove).toBe("function");
    const port = await listenOnce(server);
    const base = `http://127.0.0.1:${port}`;

    const resp = await fetch(`${base}/wrapped/3`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-dataflow-trace-id")).toMatch(/^[0-9a-f]{16}$/);
    const spans = await waitForServerSpans(1);
    expect(spans[0]!.name).toBe("GET /wrapped/3");
    expect(spans[0]!.status_code).toBe(200);

    remove!();
    // The marker was cleared, so the server is instrumentable again...
    expect(typeof instrumentHttpServer(server)).toBe("function");
    restoreNest(); // ...and clean it back up
    await fetch(`${base}/after`);
    await sleep(50);
    expect(events.filter((e) => e.type === "HTTP_SERVER")).toHaveLength(1);
  });

  it("returns null when the server has no request listeners yet", () => {
    server = createServer();
    expect(instrumentHttpServer(server)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// instrumentAxios
// ---------------------------------------------------------------------------

describe("instrumentAxios", () => {
  it("emits an HTTP_CLIENT span and propagates the trace header when joining a trace", async () => {
    const tgt = await startCollector();
    target = tgt;
    const instance = axios.create();
    instrumentAxios(instance);

    await trace("outer.Call", async () => {
      await instance.get(`${tgt.url}/orders?limit=2`);
    });

    const parent = events.find((e) => e.name === "outer.Call")!;
    const ev = events.find((e) => e.type === "HTTP_CLIENT")!;
    expect(ev.name).toBe(`GET 127.0.0.1:${target.port}/orders`);
    expect(ev.trace_id).toBe(parent.trace_id);
    expect(ev.parent_span_id).toBe(parent.span_id);
    expect(ev.status_code).toBe(200);
    expect(ev.error_message).toBe("");
    expect(ev.metadata["http.method"]).toBe("GET");
    expect(ev.metadata["http.url"]).toBe(`${target.url}/orders?limit=2`);
    expect(ev.callee_package).toBe(`127.0.0.1:${target.port}`);

    // The downstream service received the header and joined the trace.
    const req = target.requests[0]!;
    expect(req.path).toBe("/orders?limit=2");
    expect(req.headers["x-dataflow-trace-id"]).toBe(ev.trace_id);
  });

  it("roots a client span outside any trace without injecting a header", async () => {
    target = await startCollector();
    const instance = axios.create();
    instrumentAxios(instance);

    const resp = await instance.get(`${target.url}/solo`);
    expect(resp.status).toBe(200);
    const ev = events.find((e) => e.type === "HTTP_CLIENT")!;
    expect(ev.parent_span_id).toBe("");
    expect(target.requests[0]!.headers["x-dataflow-trace-id"]).toBeUndefined();
  });

  it("records connection failures with status 503 and re-throws", async () => {
    const instance = axios.create();
    instrumentAxios(instance);

    // Nothing listens on port 1 (a reserved port) — connection refused.
    await expect(instance.get("http://127.0.0.1:1/orders")).rejects.toThrow();
    const ev = events.find((e) => e.type === "HTTP_CLIENT")!;
    expect(ev.name).toBe("GET 127.0.0.1:1/orders");
    expect(ev.status_code).toBe(503);
    expect(ev.error_message).not.toBe("");
  });

  it("records non-2xx responses with the response status", async () => {
    target = await startCollector();
    target.respondWith(500);
    const instance = axios.create();
    instrumentAxios(instance);

    await expect(instance.get(`${target.url}/flaky`)).rejects.toThrow();
    const ev = events.find((e) => e.type === "HTTP_CLIENT")!;
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toContain("500");
  });

  it("skips requests aimed at the SDK's own endpoint (isOwnEndpoint)", async () => {
    collector = await startCollector();
    configure({ endpoint: collector.url });
    const instance = axios.create();
    instrumentAxios(instance);

    const resp = await instance.get(`${collector.url}/api/v1/health`);
    expect(resp.status).toBe(200);
    expect(events.filter((e) => e.type === "HTTP_CLIENT")).toHaveLength(0);
  });

  it("is idempotent per instance and restoreAxios() ejects the interceptors", async () => {
    target = await startCollector();
    const instance = axios.create();
    instrumentAxios(instance);
    instrumentAxios(instance); // second install is a no-op
    await instance.get(`${target.url}/once`);
    expect(events.filter((e) => e.type === "HTTP_CLIENT")).toHaveLength(1);

    restoreAxios();
    await instance.get(`${target.url}/twice`);
    expect(events.filter((e) => e.type === "HTTP_CLIENT")).toHaveLength(1);

    // Re-installable after a restore.
    instrumentAxios(instance);
    await instance.get(`${target.url}/thrice`);
    expect(events.filter((e) => e.type === "HTTP_CLIENT")).toHaveLength(2);
  });

  it("passes through untouched when the SDK is disabled", async () => {
    target = await startCollector();
    configure({ disabled: true });
    const instance = axios.create();
    instrumentAxios(instance);

    const resp = await instance.get(`${target.url}/quiet`);
    expect(resp.status).toBe(200);
    expect(events).toHaveLength(0);
    expect(target.requests[0]!.headers["x-dataflow-trace-id"]).toBeUndefined();
  });

  it("ignores objects without an interceptor registry", () => {
    expect(() => instrumentAxios({})).not.toThrow();
    expect(() => instrumentAxios({ interceptors: {} })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// instrumentMongoose (duck-typed connection/model/schema — no mongodb)
// ---------------------------------------------------------------------------

type MongoosePreHook = (this: unknown, next: (...args: unknown[]) => void, ...rest: unknown[]) => void;
type MongoosePostHook = (this: unknown, ...args: unknown[]) => void;

class FakeSchema {
  preHooks = new Map<string, MongoosePreHook[]>();
  postHooks = new Map<string, MongoosePostHook[]>();

  pre(op: string, fn: MongoosePreHook): void {
    const list = this.preHooks.get(op) ?? [];
    list.push(fn);
    this.preHooks.set(op, list);
  }

  post(op: string, fn: MongoosePostHook): void {
    const list = this.postHooks.get(op) ?? [];
    list.push(fn);
    this.postHooks.set(op, list);
  }

  /** Drives the registered hooks around a fake exec; fails the query when err is set. */
  async run(op: string, self: unknown, exec: () => unknown, err?: Error): Promise<unknown> {
    for (const hook of this.preHooks.get(op) ?? []) {
      await new Promise<void>((resolve) => hook.call(self, () => resolve()));
    }
    if (err !== undefined) {
      // error post hooks have arity 3: (err, docs, next)
      for (const hook of this.postHooks.get(op) ?? []) {
        if (hook.length === 3) {
          await new Promise<void>((resolve) => hook.call(self, err, undefined, () => resolve()));
        }
      }
      throw err;
    }
    const out = await exec();
    // success post hooks have arity 2: (docs, next)
    for (const hook of this.postHooks.get(op) ?? []) {
      if (hook.length === 2) {
        await new Promise<void>((resolve) => hook.call(self, out, () => resolve()));
      }
    }
    return out;
  }
}

class FakeModelBase {
  static schema: FakeSchema = new FakeSchema();
  static modelName = "";

  static async find(): Promise<unknown[]> {
    return (await this.schema.run("find", this, () => [{ id: 1 }])) as unknown[];
  }

  static async boom(op: string, err: Error): Promise<never> {
    return (await this.schema.run(op, this, () => ({}), err)) as never;
  }

  async save(): Promise<this> {
    const ctor = this.constructor as typeof FakeModelBase;
    return (await ctor.schema.run("save", this, () => this)) as this;
  }
}

class FakeConnection {
  models: unknown[] = [];
  private cache = new Map<string, unknown>();

  model(name: string, schema?: FakeSchema): unknown {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;
    if (schema === undefined) {
      throw new Error(`MissingSchemaError: schema for ${name} not registered`);
    }
    const model = class extends FakeModelBase {};
    model.schema = schema;
    model.modelName = name;
    this.cache.set(name, model);
    this.models.push(model);
    return model;
  }
}

describe("instrumentMongoose", () => {
  it("emits DB_QUERY spans for new models: FIND User with mongodb metadata", async () => {
    const conn = new FakeConnection();
    instrumentMongoose(conn);
    const User = conn.model("User", new FakeSchema()) as typeof FakeModelBase;

    const out = await User.find();
    expect(out).toEqual([{ id: 1 }]);

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("DB_QUERY");
    expect(ev.name).toBe("FIND User");
    expect(ev.callee_package).toBe("mongodb");
    expect(ev.metadata["db.system"]).toBe("mongodb");
    expect(ev.metadata["db.operation"]).toBe("find");
    expect(ev.metadata["db.model"]).toBe("User");
    expect(ev.status_code).toBe(200);
    expect(ev.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("names document saves after the op: SAVE User", async () => {
    const conn = new FakeConnection();
    instrumentMongoose(conn);
    const User = conn.model("User", new FakeSchema()) as typeof FakeModelBase;

    await new User().save();
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("SAVE User");
    expect(events[0]!.metadata["db.operation"]).toBe("save");
    expect(events[0]!.status_code).toBe(200);
  });

  it("records failing operations with status 500, error.stack, and re-throws", async () => {
    const conn = new FakeConnection();
    instrumentMongoose(conn);
    const Repo = conn.model("Repo", new FakeSchema()) as typeof FakeModelBase;

    await expect(Repo.boom("deleteOne", new Error("mongo down"))).rejects.toThrow("mongo down");
    const ev = events[0]!;
    expect(ev.name).toBe("DELETE_ONE Repo");
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toBe("mongo down");
    const stack = ev.metadata["error.stack"];
    expect(stack).toBeTruthy();
    expect(stack!.length).toBeLessThanOrEqual(8192);
  });

  it("covers models compiled before instrumentation (connection.models)", async () => {
    const conn = new FakeConnection();
    const User = conn.model("User", new FakeSchema()) as typeof FakeModelBase;
    instrumentMongoose(conn);

    await User.find();
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("FIND User");
  });

  it("nests under the active trace", async () => {
    const conn = new FakeConnection();
    instrumentMongoose(conn);
    const User = conn.model("User", new FakeSchema()) as typeof FakeModelBase;

    await trace("app.Work", async () => {
      await User.find();
    });
    const parent = events.find((e) => e.name === "app.Work")!;
    const child = events.find((e) => e.type === "DB_QUERY")!;
    expect(child.trace_id).toBe(parent.trace_id);
    expect(child.parent_span_id).toBe(parent.span_id);
  });

  it("is idempotent per connection and restoreMongoose() unwraps the factory", async () => {
    const conn = new FakeConnection();
    const originalModel = conn.model;
    instrumentMongoose(conn);
    const wrapped = conn.model;
    instrumentMongoose(conn);
    expect(conn.model).toBe(wrapped); // second install is a no-op

    const User = conn.model("User", new FakeSchema()) as typeof FakeModelBase;
    await User.find();
    expect(events.filter((e) => e.type === "DB_QUERY")).toHaveLength(1);

    restoreMongoose();
    expect(conn.model).toBe(originalModel);
    const After = conn.model("After", new FakeSchema()) as typeof FakeModelBase;
    await After.find();
    expect(events.filter((e) => e.type === "DB_QUERY")).toHaveLength(1); // unchanged
  });

  it("passes through untouched when the SDK is disabled", async () => {
    configure({ disabled: true });
    const conn = new FakeConnection();
    instrumentMongoose(conn);
    const User = conn.model("User", new FakeSchema()) as typeof FakeModelBase;

    await User.find();
    expect(events).toHaveLength(0);
  });

  it("ignores connections without a model factory", () => {
    expect(() => instrumentMongoose({})).not.toThrow();
  });
});
