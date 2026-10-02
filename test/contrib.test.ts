import { Writable } from "node:stream";

import pino from "pino";
import winston from "winston";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  instrumentMysql,
  instrumentPg,
  instrumentPino,
  instrumentWinston,
  restoreMysql,
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
import { bodyText, parseBody, resetSdk, startCollector, type Collector } from "./helpers.js";

let events: EventWire[] = [];
let lines: LogWire[] = [];
let collector: Collector | undefined;

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
  restorePino();
  restoreWinston();
  _setLogsSinkForTests(null);
  _setSinkForTests(null);
  _resetLogsForTests();
  resetPipeline();
  _resetForTests();
  await collector?.close();
  collector = undefined;
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
  class Payments {
    fee = 3;

    @Traced()
    charge(x: number): number {
      return x + this.fee;
    }

    @Traced({ name: "custom.Name" })
    async fail(): Promise<never> {
      throw new Error("declined");
    }
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
});
