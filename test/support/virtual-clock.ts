// A virtual clock for the Clock port. advance() fires every timer that falls due in time order and
// lets the caller settle (await in-flight requests, pending writes) after each one, so a timer that
// starts a request sees its response before the clock moves on.

import type { Clock } from "../../src/core/ports";

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

export class VirtualClock implements Clock {
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(private current = Date.parse("2026-10-28T10:00:00.000Z")) {}

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { id: this.nextId++, at: this.current + Math.max(0, ms), fn };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  pending(): number {
    return this.timers.length;
  }

  async advance(ms: number, settle: () => Promise<void> = async () => undefined): Promise<void> {
    const target = this.current + ms;
    await settle();
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.current = Math.max(this.current, due.at);
      due.fn();
      await settle();
    }
    this.current = target;
    await settle();
  }
}
