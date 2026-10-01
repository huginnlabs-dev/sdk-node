import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetForTests, configure } from "../src/config.js";
import { dbSpan } from "../src/instrument.js";
import { _setSinkForTests, _resetForTests as resetPipeline } from "../src/pipeline.js";
import { trace } from "../src/trace.js";
import type { EventWire } from "../src/types.js";
import { resetSdk } from "./helpers.js";

let events: EventWire[] = [];

beforeEach(() => {
  resetSdk();
  events = [];
  _setSinkForTests((ev) => events.push(ev));
  configure({ apiKey: "df_test_key", endpoint: "http://127.0.0.1:9" });
});

afterEach(() => {
  resetPipeline();
});

describe("dbSpan", () => {
  it("emits a DB_QUERY span named after the statement summary", async () => {
    const out = await dbSpan("postgres", "SELECT id, total FROM orders WHERE id = $1", () => 42);
    expect(out).toBe(42);

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("DB_QUERY");
    expect(ev.name).toBe("SELECT orders");
    expect(ev.callee_package).toBe("postgres");
    expect(ev.status_code).toBe(200);
    expect(ev.error_message).toBe("");
    expect(ev.metadata["db.system"]).toBe("postgres");
    expect(ev.metadata["db.statement"]).toBe("SELECT id, total FROM orders WHERE id = $1");
  });

  it("works with async callbacks", async () => {
    await dbSpan("mysql", "UPDATE public.items SET total = total - 1", async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const ev = events[0]!;
    expect(ev.type).toBe("DB_QUERY");
    expect(ev.name).toBe("UPDATE items");
    expect(ev.status_code).toBe(200);
    expect(ev.duration_ms).toBeGreaterThanOrEqual(5);
  });

  it("single-spaces and truncates db.statement at 200 chars", async () => {
    const long = "SELECT   *\n  FROM   logs WHERE " + "payload = 'x' OR ".repeat(20) + "1=1";
    await dbSpan("postgres", long, () => {});
    const ev = events[0]!;
    expect(ev.metadata["db.statement"]).toHaveLength(200);
    expect(ev.metadata["db.statement"]).not.toContain("\n");
    expect(ev.metadata["db.statement"]).not.toContain("  ");
    expect(ev.name).toBe("SELECT logs");
  });

  it("records errors with status 500 and a clipped stack, then re-throws (sync)", () => {
    const boom = new Error("boom");
    expect(() =>
      dbSpan("sqlite", "DELETE FROM sessions WHERE expires < now()", () => {
        throw boom;
      }),
    ).toThrow(boom);

    const ev = events[0]!;
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toBe("boom");
    const stack = ev.metadata["error.stack"];
    expect(stack).toBeTruthy();
    expect(stack!.length).toBeLessThanOrEqual(8192);
    expect(stack).toContain("boom");
  });

  it("records errors and re-throws for rejected async callbacks", async () => {
    await expect(
      dbSpan("mongo", "INSERT INTO audits VALUES ($1)", async () => {
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");

    const ev = events[0]!;
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toBe("async boom");
    expect(ev.metadata["db.system"]).toBe("mongo");
  });

  it("nests under the active trace", async () => {
    await trace("payments.Charge", async () => {
      await dbSpan("postgres", "SELECT * FROM users", () => {});
    });
    expect(events).toHaveLength(2);
    const parent = events.find((e) => e.name === "payments.Charge")!;
    const child = events.find((e) => e.type === "DB_QUERY")!;
    expect(child.trace_id).toBe(parent.trace_id);
    expect(child.parent_span_id).toBe(parent.span_id);
  });
});
