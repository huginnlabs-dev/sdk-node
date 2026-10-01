import type { EventWire } from "./types.js";

/**
 * Bounded FIFO with drop-oldest semantics and monotonic per-process
 * sequence numbers (mirrors the fleet's event buffers).
 */
export class EventBuffer {
  private readonly capacity: number;
  private readonly events: EventWire[] = [];
  private bytes = 0;
  private dropped = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /** Appends an event; the oldest is dropped when the buffer is full. */
  add(ev: EventWire): void {
    const size = approxBytes(ev);
    if (this.events.length >= this.capacity) {
      const oldest = this.events.shift();
      if (oldest) this.bytes -= approxBytes(oldest);
      this.dropped += 1;
    }
    this.events.push(ev);
    this.bytes += size;
  }

  /** Removes and returns every buffered event (up to max), oldest first. */
  drain(max = Infinity): EventWire[] {
    if (this.events.length === 0) return [];
    const take = Math.min(this.events.length, Math.max(1, max));
    const out = this.events.splice(0, take);
    for (const ev of out) this.bytes -= approxBytes(ev);
    return out;
  }

  get length(): number {
    return this.events.length;
  }

  get bufferedBytes(): number {
    return this.bytes;
  }

  get droppedCount(): number {
    return this.dropped;
  }
}

/** Rough on-wire size used for the >1MB flush trigger. */
export function approxBytes(ev: EventWire): number {
  let size = 256; // fixed fields + JSON overhead
  size += ev.name.length + ev.trace_id.length + ev.span_id.length + ev.parent_span_id.length;
  size += ev.service_name.length + ev.error_message.length;
  for (const [k, v] of Object.entries(ev.metadata)) size += k.length + v.length + 8;
  if (ev.payload) size += ev.payload.data_b64.length + ev.payload.iv_b64.length + 64;
  return size;
}
