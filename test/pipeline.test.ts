import { afterEach, describe, expect, it, vi } from "vitest";

import { _resetForTests, configure, settings } from "../src/config.js";
import { trace } from "../src/trace.js";
import { flushNow } from "../src/pipeline.js";
import { bodyText, parseBody, resetSdk, startCollector, type Collector } from "./helpers.js";
import type { EventWire } from "../src/types.js";

let collector: Collector;

async function ingestRequests(): Promise<ReturnType<Collector["waitFor"]>> {
  return collector.waitFor("/api/v1/ingest", 1);
}

afterEach(async () => {
  await collector?.close();
});

describe("delivery pipeline", () => {
  it("POSTs {events:[...]} to /api/v1/ingest with X-Api-Key and a monotonic seq", async () => {
    collector = await startCollector();
    resetSdk();
    configure({ apiKey: "df_test_key", endpoint: collector.url });

    await trace("a.One", (s) => s.setAttr("i", "1"));
    await trace("b.Two", (s) => s.setAttr("i", "2"));
    await flushNow();

    const reqs = await ingestRequests();
    expect(reqs).toHaveLength(1);
    const req = reqs[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers["x-api-key"]).toBe("df_test_key");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["content-encoding"]).toBeUndefined(); // small body: no gzip

    const body = parseBody(req);
    const events = body.events as EventWire[];
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.name).sort()).toEqual(["a.One", "b.Two"]);
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(2);
    expect(Math.max(...seqs)).toBeGreaterThan(0);
  });

  it("flushes automatically at 100 buffered events (count trigger)", async () => {
    collector = await startCollector();
    resetSdk();
    configure({ apiKey: "df_test_key", endpoint: collector.url });

    for (let i = 0; i < 100; i += 1) trace(`job.${i}`, () => {});
    const reqs = await collector.waitFor("/api/v1/ingest", 1);
    expect((parseBody(reqs[0]!).events as unknown[]).length).toBe(100);
  });

  it("gzips bodies over 4KB (Content-Encoding: gzip, server-side decode)", async () => {
    collector = await startCollector();
    resetSdk();
    configure({ apiKey: "df_test_key", endpoint: collector.url });

    await trace("big.Payload", (s) => {
      s.setData("blob", "x".repeat(6000));
      s.setData("blob2", "y".repeat(2000));
    });
    await flushNow();

    const reqs = await ingestRequests();
    const req = reqs[0]!;
    expect(req.headers["content-encoding"]).toBe("gzip");
    const body = JSON.parse(bodyText(req)) as { events: EventWire[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.metadata["data.fields"]).toBe("blob,blob2");
  });

  it("retries with backoff on server errors and delivers once recovered", async () => {
    collector = await startCollector();
    collector.respondWith(500);
    resetSdk();
    configure({ apiKey: "df_test_key", endpoint: collector.url, sampleRatio: 1 });

    await trace("retry.Me", () => {});
    const flushPromise = flushNow();

    // Recover after the first attempt: flip the collector to 200 once the
    // first failed POST lands.
    await collector.waitFor("/api/v1/ingest", 1);
    collector.respondWith(200);

    await expect(flushPromise).resolves.toBeUndefined();
    const reqs = await collector.waitFor("/api/v1/ingest", 2);
    // Same batch re-posted after the transient failure:
    const bodies = reqs.map((r) => parseBody(r).events as EventWire[]);
    expect(bodies[0]).toHaveLength(1);
    expect(bodies[1]![0]!.event_id).toBe(bodies[0]![0]!.event_id);
  });

  it("drops the batch after the final retry attempt without throwing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      collector = await startCollector();
      collector.respondWith(500);
      resetSdk();
      const warnings: string[] = [];
      configure({
        apiKey: "df_test_key",
        endpoint: collector.url,
        logger: (m) => warnings.push(m),
      });

      await trace("drop.Me", () => {});
      await expect(flushNow()).resolves.toBeUndefined();

      const reqs = await collector.waitFor("/api/v1/ingest", 3, 15000);
      expect(reqs).toHaveLength(3);
      expect(warnings.join("\n")).toMatch(/failed after 3 attempts.*dropping 1 events/);
      // buffer is empty afterwards
      const { flushNow: flushAgain } = await import("../src/pipeline.js");
      await flushAgain();
      expect(reqs).toHaveLength(3); // nothing more to send
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops non-retryable 4xx batches immediately", async () => {
    collector = await startCollector();
    collector.respondWith(400);
    resetSdk();
    const warnings: string[] = [];
    configure({ apiKey: "df_test_key", endpoint: collector.url, logger: (m) => warnings.push(m) });

    await trace("reject.Me", () => {});
    await flushNow();

    const reqs = await collector.waitFor("/api/v1/ingest", 1);
    await new Promise((r) => setTimeout(r, 250)); // allow any (wrong) retry to land
    expect(reqs).toHaveLength(1);
    expect(warnings.join("\n")).toMatch(/rejected batch \(HTTP 400\)/);
  });

  it("stays passive when disabled and never touches the network", async () => {
    collector = await startCollector();
    resetSdk();
    configure({ apiKey: "df_test_key", endpoint: collector.url, disabled: true });

    await trace("quiet.Op", () => {});
    await flushNow();
    await new Promise((r) => setTimeout(r, 200));
    expect(collector.requests).toHaveLength(0);
  });

  it("stays passive without an API key", async () => {
    collector = await startCollector();
    resetSdk();
    configure({ endpoint: collector.url });

    await trace("quiet.Op", () => {});
    await flushNow();
    await new Promise((r) => setTimeout(r, 200));
    expect(collector.requests).toHaveLength(0);
  });

  it("drops events with a warning when the endpoint is a bare host:port", async () => {
    collector = await startCollector(); // unused; endpoint is intentionally unusable
    resetSdk();
    const warnings: string[] = [];
    configure({ apiKey: "df_test_key", endpoint: "api.huginnlabs.com:9090", logger: (m) => warnings.push(m) });
    expect(settings().endpoint).toBe("api.huginnlabs.com:9090");

    await trace("nowhere.Op", () => {});
    await flushNow();
    await new Promise((r) => setTimeout(r, 200));
    expect(collector.requests).toHaveLength(0);
    expect(warnings.join("\n")).toMatch(/no HTTP base to POST events to/);
    await collector.close();
  });
});
