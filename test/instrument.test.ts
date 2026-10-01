import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetForTests, configure } from "../src/config.js";
import { instrumentHttp, restoreHttp } from "../src/instrument.js";
import { _setSinkForTests, _resetForTests as resetPipeline } from "../src/pipeline.js";
import http from "node:http";
import https from "node:https";
import { trace } from "../src/trace.js";
import type { EventWire } from "../src/types.js";
import { closeServer, resetSdk } from "./helpers.js";

let events: EventWire[] = [];
let target: Server;
let targetBase = "";
let targetStatus = 200;
const targetHeaders: IncomingHttpHeaders[] = [];

const originalHttpRequest = http.request;
const originalHttpGet = http.get;
const originalHttpsRequest = https.request;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  resetSdk();
  events = [];
  targetHeaders.length = 0;
  _setSinkForTests((ev) => events.push(ev));
  configure({ apiKey: "df_test_key", endpoint: "http://127.0.0.1:9" });

  target = createServer((req, res) => {
    targetHeaders.push(req.headers);
    res.statusCode = targetStatus;
    res.setHeader("Content-Type", "text/plain");
    res.end("ok");
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
  targetBase = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  targetStatus = 200;
});

afterEach(async () => {
  restoreHttp();
  await closeServer(target);
  resetPipeline();
});

function httpRequest(url: string, options: Record<string, unknown> = {}): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => resolve(res));
    req.once("error", reject);
    req.end();
  });
}

function httpGet(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => resolve(res)).once("error", reject);
  });
}

describe("instrumentHttp (node:http / node:https)", () => {
  it("emits an HTTP_CLIENT span joined to the active trace, injecting the header", async () => {
    instrumentHttp();
    let outerId = "";
    await trace("outer.Op", async (outer) => {
      outerId = outer.traceId;
      const res = await httpRequest(`${targetBase}/ping?x=1`, { headers: { "x-a": "b" } });
      expect(res.statusCode).toBe(200);
      res.resume();
      await new Promise<void>((resolve) => res.on("end", resolve));
    });

    const ev = events.find((e) => e.type === "HTTP_CLIENT")!;
    expect(ev).toBeDefined();
    expect(ev.name).toBe(`GET 127.0.0.1:${(target.address() as AddressInfo).port}/ping`);
    expect(ev.callee_package).toBe(`127.0.0.1:${(target.address() as AddressInfo).port}`);
    expect(ev.metadata["http.method"]).toBe("GET");
    expect(ev.metadata["http.url"]).toBe(`${targetBase}/ping?x=1`);
    expect(ev.status_code).toBe(200);
    expect(ev.error_message).toBe("");
    expect(ev.trace_id).toBe(outerId);
    expect(ev.parent_span_id).toMatch(/^[0-9a-f]{16}$/);

    const sentHeader = targetHeaders[0]?.["x-dataflow-trace-id"];
    expect(sentHeader).toBe(ev.trace_id);
    expect(targetHeaders[0]?.["x-a"]).toBe("b");
  });

  it("records without a trace header when no span is active", async () => {
    instrumentHttp();
    const res = await httpRequest(`${targetBase}/plain`);
    res.resume();

    await trace("later.Op", () => {});
    const ev = events.find((e) => e.type === "HTTP_CLIENT")!;
    expect(ev).toBeDefined();
    expect(ev.parent_span_id).toBe(""); // roots a fresh trace
    expect(targetHeaders[0]?.["x-dataflow-trace-id"]).toBeUndefined();
  });

  it("never overrides a caller-provided X-Dataflow-Trace-Id", async () => {
    instrumentHttp();
    await trace("outer.Op", async () => {
      await httpRequest(`${targetBase}/kept`, { headers: { "X-Dataflow-Trace-Id": "abc123" } });
    });
    expect(targetHeaders[0]?.["x-dataflow-trace-id"]).toBe("abc123");
  });

  it("spans http.get exactly once (get delegates to the wrapped request)", async () => {
    instrumentHttp();
    await trace("outer.Op", async () => {
      const res = await httpGet(`${targetBase}/via-get`);
      res.resume();
    });
    const clientEvents = events.filter((e) => e.type === "HTTP_CLIENT");
    expect(clientEvents).toHaveLength(1);
    expect(clientEvents[0]!.name).toBe(`GET 127.0.0.1:${(target.address() as AddressInfo).port}/via-get`);
    expect(targetHeaders[0]?.["x-dataflow-trace-id"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records connection errors as status 503", async () => {
    // Claim a port, then close the server so dialing it refuses.
    const dead = createServer(() => {});
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", () => resolve()));
    const deadPort = (dead.address() as AddressInfo).port;
    await closeServer(dead);

    instrumentHttp();
    await trace("outer.Op", async () => {
      await expect(httpRequest(`http://127.0.0.1:${deadPort}/nowhere`)).rejects.toThrow();
    });

    const ev = events.find((e) => e.type === "HTTP_CLIENT")!;
    expect(ev.status_code).toBe(503);
    expect(ev.error_message).not.toBe("");
  });

  it("flags 5xx responses like server spans do", async () => {
    targetStatus = 500;
    instrumentHttp();
    await trace("outer.Op", async () => {
      const res = await httpRequest(`${targetBase}/broken`);
      res.resume();
    });
    const ev = events.find((e) => e.type === "HTTP_CLIENT")!;
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toBe("http 500");
  });

  it("is idempotent and restores the original module identities", async () => {
    instrumentHttp();
    const firstWrap = http.request;
    instrumentHttp();
    expect(http.request).toBe(firstWrap);
    expect(http.request).not.toBe(originalHttpRequest);
    expect(https.request).not.toBe(originalHttpsRequest);

    restoreHttp();
    expect(http.request).toBe(originalHttpRequest);
    expect(http.get).toBe(originalHttpGet);
    expect(https.request).toBe(originalHttpsRequest);

    // Requests after restore are uninstrumented.
    await trace("outer.Op", async () => {
      const res = await httpRequest(`${targetBase}/plain-again`);
      res.resume();
    });
    expect(events.filter((e) => e.type === "HTTP_CLIENT")).toHaveLength(0);
    expect(targetHeaders[0]?.["x-dataflow-trace-id"]).toBeUndefined();
  });

  it("passes through untouched when the SDK is disabled", async () => {
    configure({ disabled: true });
    instrumentHttp();
    await trace("outer.Op", async () => {
      await httpRequest(`${targetBase}/quiet`);
    });
    expect(events.filter((e) => e.type === "HTTP_CLIENT")).toHaveLength(0);
    expect(targetHeaders[0]?.["x-dataflow-trace-id"]).toBeUndefined();
  });
});

describe("instrumentHttp (global fetch)", () => {
  it("wraps fetch, joins the trace and injects the header", async () => {
    instrumentHttp();
    expect(globalThis.fetch).not.toBe(originalFetch);

    let outerId = "";
    await trace("outer.Op", async (outer) => {
      outerId = outer.traceId;
      const resp = await fetch(`${targetBase}/fetch-path`);
      expect(resp.status).toBe(200);
      await resp.text();
    });

    const ev = events.find((e) => e.type === "HTTP_CLIENT")!;
    expect(ev.name).toBe(`GET 127.0.0.1:${(target.address() as AddressInfo).port}/fetch-path`);
    expect(ev.metadata["http.url"]).toBe(`${targetBase}/fetch-path`);
    expect(ev.trace_id).toBe(outerId);
    expect(targetHeaders[0]?.["x-dataflow-trace-id"]).toBe(ev.trace_id);

    restoreHttp();
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("records fetch calls without an active trace and without header injection", async () => {
    instrumentHttp();
    const resp = await fetch(`${targetBase}/root-fetch`);
    await resp.text();

    const ev = events.find((e) => e.type === "HTTP_CLIENT")!;
    expect(ev.parent_span_id).toBe("");
    expect(targetHeaders[0]?.["x-dataflow-trace-id"]).toBeUndefined();
  });

  it("records fetch failures as status 503", async () => {
    const dead = createServer(() => {});
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", () => resolve()));
    const deadPort = (dead.address() as AddressInfo).port;
    await closeServer(dead);

    instrumentHttp();
    await trace("outer.Op", async () => {
      await expect(fetch(`http://127.0.0.1:${deadPort}/x`)).rejects.toThrow();
    });
    const ev = events.find((e) => e.type === "HTTP_CLIENT")!;
    expect(ev.status_code).toBe(503);
    expect(ev.error_message).not.toBe("");
  });
});
