import { describe, expect, it } from "vitest";

import { _resetForTests, configure, normalizedRatio, shouldSample } from "../src/config.js";
import { startSpan } from "../src/trace.js";
import { _setSinkForTests, _resetForTests as resetPipeline } from "../src/pipeline.js";
import type { EventWire } from "../src/types.js";
import { resetSdk } from "./helpers.js";

describe("sampling", () => {
  it("normalizes the ratio: negatives/NaN fall back to full fidelity, >1 clamps", () => {
    expect(normalizedRatio(0.5)).toBe(0.5);
    expect(normalizedRatio(1)).toBe(1);
    expect(normalizedRatio(7)).toBe(1);
    expect(normalizedRatio(-1)).toBe(1);
    expect(normalizedRatio(Number.NaN)).toBe(1);
  });

  it("ratio >= 1 always samples (fleet shouldSample semantics)", () => {
    _resetForTests({ sampleRatio: 1 });
    for (let i = 0; i < 20; i += 1) expect(shouldSample()).toBe(true);
  });

  it("ratio 0 samples nothing", () => {
    _resetForTests({ sampleRatio: 0 });
    for (let i = 0; i < 20; i += 1) expect(shouldSample()).toBe(false);
  });

  it("ratio 0.5 samples roughly half (statistical bounds)", () => {
    _resetForTests({ sampleRatio: 0.5 });
    let hits = 0;
    for (let i = 0; i < 2000; i += 1) if (shouldSample()) hits += 1;
    expect(hits).toBeGreaterThan(700);
    expect(hits).toBeLessThan(1300);
  });

  it("unsampled spans never reach the delivery path", () => {
    resetSdk();
    configure({ sampleRatio: 0 });
    const events: EventWire[] = [];
    _setSinkForTests((ev) => events.push(ev));
    for (let i = 0; i < 10; i += 1) startSpan("drop.Me").end();
    expect(events).toHaveLength(0);
    resetPipeline();
  });

  it("sampled spans keep flowing", () => {
    resetSdk();
    configure({ sampleRatio: 1 });
    const events: EventWire[] = [];
    _setSinkForTests((ev) => events.push(ev));
    for (let i = 0; i < 10; i += 1) startSpan("keep.Me").end();
    expect(events).toHaveLength(10);
    resetPipeline();
  });
});
