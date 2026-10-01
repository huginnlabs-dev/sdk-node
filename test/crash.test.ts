import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetForTests, configure } from "../src/config.js";
import { capture, captureUncaught, restoreCrash } from "../src/crash.js";
import { _setSinkForTests, _resetForTests as resetPipeline } from "../src/pipeline.js";
import { trace } from "../src/trace.js";
import type { EventWire } from "../src/types.js";
import { resetSdk } from "./helpers.js";

let events: EventWire[] = [];

let baselineUncaught = 0;
let baselineRejection = 0;

beforeEach(() => {
  resetSdk();
  events = [];
  _setSinkForTests((ev) => events.push(ev));
  configure({ apiKey: "df_test_key", endpoint: "http://127.0.0.1:9" });
  restoreCrash();
  baselineUncaught = process.listeners("uncaughtException").length;
  baselineRejection = process.listeners("unhandledRejection").length;
});

afterEach(() => {
  restoreCrash();
  resetPipeline();
});

describe("capture", () => {
  it("records on the current span and re-throws (sync)", () => {
    expect(() =>
      trace("outer.Op", () => {
        capture(() => {
          throw new Error("boom");
        });
      }),
    ).toThrow("boom");

    expect(events).toHaveLength(1); // recorded on the active span, no synthetic
    const ev = events[0]!;
    expect(ev.name).toBe("outer.Op");
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toBe("Error: boom");
    expect(ev.metadata["error.stack"]).toContain("boom");
  });

  it("records on the current span and re-throws (async)", async () => {
    await expect(
      trace("outer.Op", () =>
        capture(async () => {
          throw new Error("async boom");
        }),
      ),
    ).rejects.toThrow("async boom");

    const ev = events[0]!;
    expect(ev.name).toBe("outer.Op");
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toBe("Error: async boom");
  });

  it("opens a synthetic 'exception' span when nothing is active", () => {
    expect(() =>
      capture(() => {
        throw new Error("orphan");
      }),
    ).toThrow("orphan");

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.name).toBe("exception");
    expect(ev.type).toBe("FUNCTION_CALL");
    expect(ev.parent_span_id).toBe("");
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toBe("Error: orphan");
  });

  it("clips the message at 500 chars and the stack at 8192", () => {
    const err = new Error("x".repeat(600));
    err.stack = "Error: " + "y".repeat(9000);
    expect(() => capture(() => { throw err; })).toThrow(err);

    const ev = events[0]!;
    expect(ev.error_message).toHaveLength(500);
    expect(ev.error_message).toBe(`Error: ${"x".repeat(493)}`);
    expect(ev.metadata["error.stack"]).toHaveLength(8192);
  });

  it("accepts non-Error throwables via String()", () => {
    expect(() => capture(() => { throw "plain string"; })).toThrow("plain string");
    const ev = events[0]!;
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toBe("plain string");
  });

  it("passes values through unchanged when nothing throws", () => {
    expect(capture(() => 41 + 1)).toBe(42);
    expect(events).toHaveLength(0);
  });
});

describe("captureUncaught", () => {
  it("installs handlers idempotently and restoreCrash removes them", () => {
    captureUncaught();
    expect(process.listeners("uncaughtException").length).toBe(baselineUncaught + 1);
    expect(process.listeners("unhandledRejection").length).toBe(baselineRejection + 1);

    captureUncaught(); // idempotent
    expect(process.listeners("uncaughtException").length).toBe(baselineUncaught + 1);

    restoreCrash();
    expect(process.listeners("uncaughtException").length).toBe(baselineUncaught);
    expect(process.listeners("unhandledRejection").length).toBe(baselineRejection);
  });

  it("installs nothing while the SDK is disabled", () => {
    configure({ disabled: true });
    captureUncaught();
    expect(process.listeners("uncaughtException").length).toBe(baselineUncaught);
    expect(process.listeners("unhandledRejection").length).toBe(baselineRejection);
  });

  it("records uncaughtException on a synthetic 'uncaught exception' span", () => {
    captureUncaught();
    process.emit("uncaughtException", new Error("kaboom"));

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.name).toBe("uncaught exception");
    expect(ev.parent_span_id).toBe("");
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toBe("Error: kaboom");
    expect(ev.metadata["error.stack"]).toContain("kaboom");
  });

  it("records unhandledRejection the same way", () => {
    captureUncaught();
    process.emit("unhandledRejection", "plain-reason", Promise.resolve());

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.name).toBe("uncaught exception");
    expect(ev.status_code).toBe(500);
    expect(ev.error_message).toBe("plain-reason");
  });

  it("keeps other listeners working and never exits on its own", () => {
    const seen: unknown[] = [];
    const other = (err: unknown): void => {
      seen.push(err);
    };
    process.on("uncaughtException", other);
    try {
      captureUncaught();
      process.emit("uncaughtException", new Error("shared"));
      expect(seen).toHaveLength(1); // the host's own listener still ran
    } finally {
      process.off("uncaughtException", other);
      restoreCrash();
    }
  });
});
