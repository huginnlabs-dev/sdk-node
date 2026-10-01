import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetForTests, configure } from "../src/config.js";
import {
  _resetLogsForTests,
  _setLogsSinkForTests,
  captureConsole,
  debug,
  error,
  flushLogs,
  info,
  LOG_LIMITS,
  log,
  logStats,
  normalizeLevel,
  restoreConsole,
  warn,
} from "../src/logs.js";
import { _setSinkForTests, flushNow } from "../src/pipeline.js";
import { instrumentHttp, restoreHttp } from "../src/instrument.js";
import { trace } from "../src/trace.js";
import type { EventWire, LogWire } from "../src/types.js";
import { bodyText, resetSdk, startCollector, type Collector } from "./helpers.js";

let collector: Collector | undefined;
let lines: LogWire[] = [];
let events: EventWire[] = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetSdk();
  lines = [];
  events = [];
  _setLogsSinkForTests((batch) => lines.push(...batch));
  _setSinkForTests((ev) => events.push(ev));
  configure({ apiKey: "df_test_key", endpoint: "http://127.0.0.1:9", serviceName: "logs-svc" });
});

afterEach(async () => {
  restoreConsole();
  restoreHttp();
  vi.restoreAllMocks();
  _setLogsSinkForTests(null);
  _setSinkForTests(null);
  _resetLogsForTests();
  await collector?.close();
  collector = undefined;
});

describe("log helpers", () => {
  it("attaches the current span's trace and span ids inside a trace", async () => {
    let ids = { trace: "", span: "" };
    await trace("app.Reserve", (s) => {
      ids = { trace: s.traceId, span: s.spanId };
      info("reserving inventory", { sku: "B-01" });
    });
    await flushLogs();

    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.trace_id).toBe(ids.trace);
    expect(line.span_id).toBe(ids.span);
    expect(line.message).toBe("reserving inventory");
    expect(line.level).toBe("info");
    expect(line.fields).toEqual({ sku: "B-01" });
    expect(line.service_name).toBe("logs-svc");
    expect(line.timestamp).toBeLessThanOrEqual(Date.now());
    expect(line.timestamp).toBeGreaterThan(Date.now() - 5000);
  });

  it("leaves trace/span ids empty outside a trace", async () => {
    error("orphan line");
    await flushLogs();

    expect(lines).toHaveLength(1);
    expect(lines[0]!.trace_id).toBe("");
    expect(lines[0]!.span_id).toBe("");
    expect(lines[0]!.level).toBe("error");
  });

  it("records all four levels and normalizes log()/level aliases", async () => {
    debug("d");
    info("i");
    warn("w");
    error("e");
    log("log", "via log");
    log("WARNING", "via warning");
    log("Verbose", "unknown falls back to info");
    await flushLogs();

    expect(lines.map((l) => l.level)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
      "info",
      "warn",
      "info",
    ]);
    expect(normalizeLevel(" log ")).toBe("info");
    expect(normalizeLevel("Error")).toBe("error");
  });

  it("stringifies field values (String(v)) and caps at 50 fields x 512 chars", async () => {
    const fields: Record<string, unknown> = { n: 42, b: true, nil: null, obj: { a: 1 } };
    for (let i = 0; i < 60; i += 1) fields[`f${i}`] = "v".repeat(600);
    info("fields", fields);
    await flushLogs();

    const f = lines[0]!.fields;
    expect(Object.keys(f)).toHaveLength(LOG_LIMITS.fieldCount);
    expect(f.n).toBe("42");
    expect(f.b).toBe("true");
    expect(f.nil).toBe("null");
    expect(f.obj).toBe("[object Object]");
    expect(f.f45).toHaveLength(LOG_LIMITS.fieldValueChars); // first 50 kept
    expect(f.f46).toBeUndefined();
  });

  it("clips messages to 8192 characters", async () => {
    info("x".repeat(9000));
    await flushLogs();
    expect(lines[0]!.message).toHaveLength(LOG_LIMITS.messageChars);
  });

  it("never throws on hostile fields and still records the line", async () => {
    const hostile = {
      get boom(): string {
        throw new Error("getter exploded");
      },
    };
    expect(() => info("with hostile fields", hostile)).not.toThrow();
    await flushLogs();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toBe("with hostile fields");
  });

  it("helpers no-op when disabled and without an API key", async () => {
    configure({ disabled: true });
    info("quiet one");
    await flushLogs();
    expect(lines).toHaveLength(0);

    _resetForTests();
    configure({ endpoint: "http://127.0.0.1:9" }); // no apiKey
    info("quiet two");
    await flushLogs();
    expect(lines).toHaveLength(0);
  });
});

describe("ring buffer", () => {
  it("keeps 1024 lines, dropping oldest and counting every drop", async () => {
    for (let i = 0; i < LOG_LIMITS.bufferLines + 5; i += 1) info(`m${i}`);
    await flushLogs();

    expect(logStats().dropped).toBe(5);
    expect(lines).toHaveLength(LOG_LIMITS.bufferLines);
    expect(lines[0]!.message).toBe("m5"); // oldest five dropped
    expect(lines[lines.length - 1]!.message).toBe("m1028");
  });

  it("drops nothing at exactly capacity", async () => {
    for (let i = 0; i < LOG_LIMITS.bufferLines; i += 1) info(`m${i}`);
    await flushLogs();

    expect(logStats().dropped).toBe(0);
    expect(lines).toHaveLength(LOG_LIMITS.bufferLines);
    expect(lines[0]!.message).toBe("m0");
  });

  it("splits drained batches at the 1000-line server cap", async () => {
    const batches: number[] = [];
    _setLogsSinkForTests((batch) => {
      batches.push(batch.length);
      lines.push(...batch);
    });

    for (let i = 0; i < 1024; i += 1) info(`m${i}`);
    await flushLogs();

    expect(batches).toEqual([1000, 24]);
    expect(lines).toHaveLength(1024);
  });
});

describe("captureConsole", () => {
  it("forwards to the original console method and records with the mapped level", async () => {
    const spy = vi.spyOn(console, "log");
    captureConsole();
    expect(console.log).not.toBe(spy); // our wrapper sits on top of the spy

    console.log("hello", { a: 1 });
    expect(spy).toHaveBeenCalledTimes(1); // forwarded untouched, output preserved
    expect(spy).toHaveBeenCalledWith("hello", { a: 1 });

    await flushLogs();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("info"); // log -> info
    expect(lines[0]!.message).toContain("hello");
  });

  it("maps debug/info/warn/error console methods to their levels", async () => {
    captureConsole();
    console.debug("d");
    console.info("i");
    console.warn("w");
    console.error("e");
    await flushLogs();

    expect(lines.map((l) => l.level)).toEqual(["debug", "info", "warn", "error"]);
    expect(lines.map((l) => l.message)).toEqual(["d", "i", "w", "e"]);
  });

  it("installs idempotently — one wrapper, one record per call", async () => {
    const spy = vi.spyOn(console, "warn");
    captureConsole();
    const wrapped = console.warn;
    captureConsole();

    expect(console.warn).toBe(wrapped);
    console.warn("once");
    expect(spy).toHaveBeenCalledTimes(1);

    await flushLogs();
    expect(lines).toHaveLength(1);

    restoreConsole();
    expect(console.warn).toBe(spy); // the spy was the original at install time
  });

  it("restoreConsole restores the original methods by identity", () => {
    const originals = {
      debug: console.debug,
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    captureConsole();
    for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
      expect(console[name]).not.toBe(originals[name]);
    }

    restoreConsole();
    restoreConsole(); // double restore is a no-op
    for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
      expect(console[name]).toBe(originals[name]);
    }
  });

  it("never swallows: a throwing original propagates and recording is skipped", () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console blew up");
    });
    captureConsole();

    expect(() => console.error("x")).toThrow("console blew up");
    expect(lines).toHaveLength(0); // recording never masks the forwarded call
  });

  it("while disabled the console still forwards but nothing is recorded", async () => {
    configure({ disabled: true });
    const spy = vi.spyOn(console, "info");
    captureConsole();

    console.info("visible");
    expect(spy).toHaveBeenCalledWith("visible");

    await flushLogs();
    expect(lines).toHaveLength(0);
  });
});

describe("log shipping", () => {
  it("POSTs {logs:[...]} to /api/v1/logs with X-Api-Key and full wire shape", async () => {
    collector = await startCollector();
    _setLogsSinkForTests(null); // ship over the network, not the sink
    configure({ apiKey: "df_log_key", endpoint: collector.url, serviceName: "log-svc" });

    await trace("op.Do", () => info("inside trace", { k: "v" }));
    await flushLogs();

    const reqs = await collector.waitFor("/api/v1/logs", 1);
    const req = reqs[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers["x-api-key"]).toBe("df_log_key");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(collector.requests.every((r) => r.path === "/api/v1/logs")).toBe(true);

    const body = JSON.parse(bodyText(req)) as { logs: LogWire[] };
    expect(body.logs).toHaveLength(1);
    const line = body.logs[0]!;
    expect(line.message).toBe("inside trace");
    expect(line.level).toBe("info");
    expect(line.fields).toEqual({ k: "v" });
    expect(line.service_name).toBe("log-svc");
    expect(line.trace_id).not.toBe("");
    expect(line.span_id).not.toBe("");
    expect(line.timestamp).toBeGreaterThan(0);
  });

  it("flushes automatically at 50 buffered lines (threshold trigger)", async () => {
    collector = await startCollector();
    _setLogsSinkForTests(null);
    configure({ apiKey: "df_test_key", endpoint: collector.url });

    for (let i = 0; i < 50; i += 1) info(`l${i}`);

    const reqs = await collector.waitFor("/api/v1/logs", 1);
    const body = JSON.parse(bodyText(reqs[0]!)) as { logs: LogWire[] };
    expect(body.logs).toHaveLength(50);
  });

  it("flushes on the 500ms background timer without an explicit flush", async () => {
    collector = await startCollector();
    _setLogsSinkForTests(null);
    configure({ apiKey: "df_test_key", endpoint: collector.url });

    info("timer line");
    const reqs = await collector.waitFor("/api/v1/logs", 1, 5000);
    expect((JSON.parse(bodyText(reqs[0]!)) as { logs: LogWire[] }).logs[0]!.message).toBe(
      "timer line",
    );
  });

  it("retries once on server errors, then drops without throwing", async () => {
    collector = await startCollector();
    collector.respondWith(500);
    _setLogsSinkForTests(null);
    const warnings: string[] = [];
    configure({
      apiKey: "df_test_key",
      endpoint: collector.url,
      logger: (m) => warnings.push(m),
    });

    info("will fail");
    await expect(flushLogs()).resolves.toBeUndefined();

    const reqs = await collector.waitFor("/api/v1/logs", 2);
    expect(reqs).toHaveLength(2); // one retry
    await sleep(250);
    expect(collector.requests.filter((r) => r.path === "/api/v1/logs")).toHaveLength(2);
    expect(warnings.join("\n")).toMatch(/log ingest failed after 2 attempts.*dropping 1 lines/);
    expect(logStats().buffered).toBe(0); // dropped, not re-queued
  });

  it("drops non-retryable 4xx batches immediately", async () => {
    collector = await startCollector();
    collector.respondWith(400);
    _setLogsSinkForTests(null);
    const warnings: string[] = [];
    configure({
      apiKey: "df_test_key",
      endpoint: collector.url,
      logger: (m) => warnings.push(m),
    });

    info("rejected");
    await flushLogs();

    const reqs = await collector.waitFor("/api/v1/logs", 1);
    await sleep(250); // allow any (wrong) retry to land
    expect(reqs).toHaveLength(1);
    expect(warnings.join("\n")).toMatch(/log ingest rejected batch \(HTTP 400\)/);
  });

  it("stays off when the endpoint is a bare host:port (logging off)", async () => {
    collector = await startCollector(); // unused; endpoint is intentionally unusable
    _setLogsSinkForTests(null);
    const warnings: string[] = [];
    configure({
      apiKey: "df_test_key",
      endpoint: "api.huginnlabs.com:9090",
      logger: (m) => warnings.push(m),
    });

    info("nowhere");
    await flushLogs();
    await sleep(200);

    expect(collector.requests).toHaveLength(0);
    expect(warnings.join("\n")).toMatch(/no HTTP base to POST logs to/);
  });

  it("never creates HTTP_CLIENT spans for its own shipping POSTs", async () => {
    collector = await startCollector();
    _setLogsSinkForTests(null);
    configure({ apiKey: "df_test_key", endpoint: collector.url });
    instrumentHttp();

    // Control: with instrumentHttp active an ordinary fetch IS traced.
    await fetch(`${collector.url}/control`, { method: "POST", body: "x" });
    await flushNow(); // ensure the control span has drained through the sink
    expect(events.some((ev) => ev.type === "HTTP_CLIENT")).toBe(true);
    const baseline = events.length;

    info("ships untraced");
    await flushLogs();
    await sleep(300); // let any (wrongly) self-traced span land

    expect(events.length).toBe(baseline); // HTTP_CLIENT events stay empty for log POSTs
    const reqs = await collector.waitFor("/api/v1/logs", 1);
    expect((JSON.parse(bodyText(reqs[0]!)) as { logs: LogWire[] }).logs[0]!.message).toBe(
      "ships untraced",
    );
  });
});
