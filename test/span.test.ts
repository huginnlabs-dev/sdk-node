import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetForTests, configure } from "../src/config.js";
import { _setSinkForTests, _resetForTests as resetPipeline } from "../src/pipeline.js";
import { currentSpan } from "../src/context.js";
import { trace, span, startSpan } from "../src/trace.js";
import type { EventWire } from "../src/types.js";
import { resetSdk } from "./helpers.js";

let events: EventWire[] = [];

beforeEach(() => {
  resetSdk();
  events = [];
  _setSinkForTests((ev) => events.push(ev));
});

afterEach(() => {
  resetPipeline();
});

describe("span core", () => {
  it("emits the fleet wire shape for a function-call span", async () => {
    configure({ serviceName: "orders" });
    await trace("payments.Charge", async (s) => {
      s.setAttr("region", "eu-1");
      s.setData("order_id", "A-123");
      await new Promise((r) => setTimeout(r, 15));
    });

    expect(events).toHaveLength(1);
    const ev = events[0] as EventWire;
    expect(ev.type).toBe("FUNCTION_CALL");
    expect(ev.name).toBe("payments.Charge");
    expect(ev.function_name).toBe("payments.Charge");
    expect(ev.service_name).toBe("orders");
    expect(ev.callee_package).toBe("payments"); // "payments.Charge" label
    expect(ev.caller_package).toBe("");
    expect(ev.duration_ms).toBeGreaterThanOrEqual(10);
    expect(ev.status_code).toBe(0);
    expect(ev.error_message).toBe("");
    // 16-hex-char fleet ids
    expect(ev.trace_id).toMatch(/^[0-9a-f]{16}$/);
    expect(ev.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(ev.event_id).toMatch(/^[0-9a-f]{16}$/);
    expect(ev.parent_span_id).toBe("");
    // payload: plaintext base64 JSON + field-name lineage
    expect(ev.payload).not.toBeNull();
    expect(ev.payload?.encrypted).toBe(false);
    const payload = JSON.parse(Buffer.from(ev.payload!.data_b64, "base64").toString("utf8")) as Record<string, unknown>;
    expect(payload).toEqual({ order_id: "A-123" });
    expect(ev.metadata["data.fields"]).toBe("order_id");
    expect(ev.metadata["data.pii"]).toBeUndefined(); // no category hit
    expect(ev.metadata["region"]).toBe("eu-1");
    expect(typeof ev.timestamp).toBe("number");
    expect(ev.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("nests spans into the active trace across await points", async () => {
    await trace("root.Op", async (root) => {
      await new Promise((r) => setTimeout(r, 5));
      await span("child.Work", async (child) => {
        expect(currentSpan()?.spanId).toBe(child.spanId);
        await new Promise((r) => setTimeout(r, 5));
        expect(currentSpan()?.spanId).toBe(child.spanId); // survives awaits
      });
      // deep nesting via ALS
      const deep = await trace("grand.Child", async () => {
        return currentSpan();
      });
      expect(deep?.parentSpanId).toBe(root.spanId);
      expect(deep?.traceId).toBe(root.traceId);
    });

    expect(events).toHaveLength(3);
    const rootEv = events.find((e) => e.name === "root.Op")!;
    const childEv = events.find((e) => e.name === "child.Work")!;
    const grandEv = events.find((e) => e.name === "grand.Child")!;
    expect(childEv.trace_id).toBe(rootEv.trace_id);
    expect(childEv.parent_span_id).toBe(rootEv.span_id);
    expect(grandEv.parent_span_id).toBe(rootEv.span_id);
  });

  it("records the first error only and rethrows (sync semantics)", () => {
    const err = new Error("kaputt");
    expect(() =>
      trace("bad.Op", (s) => {
        s.recordError(err);
        throw err; // second error attempt must not clobber
      }),
    ).toThrow("kaputt");

    expect(events).toHaveLength(1);
    expect(events[0]?.error_message).toBe("kaputt");
    expect(events[0]?.status_code).toBe(0); // SetStatus is explicit in the fleet
  });

  it("records rejected async errors and rethrows", async () => {
    await expect(
      trace("async.Bad", async () => {
        throw new Error("async kaputt");
      }),
    ).rejects.toThrow("async kaputt");
    expect(events[0]?.error_message).toBe("async kaputt");
  });

  it("stringifies non-Error rejections", async () => {
    await expect(trace("str.Bad", () => Promise.reject("plain string"))).rejects.toBe("plain string");
    expect(events[0]?.error_message).toBe("plain string");
  });

  it("supports sync callbacks", () => {
    const out = trace("sync.Op", (s) => {
      s.setStatus(200);
      return 42;
    });
    expect(out).toBe(42);
    expect(events[0]?.status_code).toBe(200);
  });

  it("end() is idempotent and setAttr after end is ignored", () => {
    const s = startSpan("manual.Op");
    s.setAttr("a", "1");
    s.end();
    s.setAttr("b", "2");
    s.recordError(new Error("late"));
    s.end();
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({ a: "1" });
    expect(events[0]?.error_message).toBe("");
  });

  it("route-style names carry no package", () => {
    const s = startSpan("GET /api/users/:id", { type: "HTTP_SERVER" });
    s.end();
    expect(events[0]?.callee_package).toBe("");
    expect(events[0]?.type).toBe("HTTP_SERVER");
    expect(events[0]?.function_name).toBe("");
  });

  it("startSpan honours an explicit parent", () => {
    const parent = startSpan("parent");
    const child = startSpan("child", { parent });
    child.end();
    parent.end();
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
  });

  it("uniquifies event and span ids", () => {
    for (let i = 0; i < 50; i += 1) startSpan("s").end();
    const ids = new Set(events.map((e) => e.event_id));
    const spans = new Set(events.map((e) => e.span_id));
    expect(ids.size).toBe(50);
    expect(spans.size).toBe(50);
  });

  it("marks unsampled spans as dropped (no event, no payload work)", () => {
    configure({ sampleRatio: 0 });
    const s = startSpan("sampled.Out");
    s.setData("x", 1);
    s.end();
    expect(events).toHaveLength(0);
  });
});
