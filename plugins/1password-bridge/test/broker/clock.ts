/** A manual clock for the broker tests: timers fire only when a test advances time. */

import type { Clock } from '../../src/broker/pool.ts';

interface Timer {
  at: number;
  fn: () => void;
  every?: number;
}

/** Lets pending promise callbacks and setImmediate work run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

export class FakeClock implements Clock {
  t = 0;
  private timers = new Map<number, Timer>();
  private nextId = 1;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  setInterval(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Moves time forward by `ms`, firing every timer due on the way at its own time. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      let next: [number, Timer] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (next === undefined || entry[1].at < next[1].at)) next = entry;
      if (next === undefined) break;
      const [id, timer] = next;
      this.t = timer.at;
      if (timer.every === undefined) this.timers.delete(id);
      else timer.at += timer.every;
      timer.fn();
    }
    this.t = end;
    await flush();
  }

  /** A machine sleep: time jumps by `ms`, then each due timer fires once, as on wake. */
  async sleep(ms: number): Promise<void> {
    this.t += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.t) continue;
      if (timer.every === undefined) this.timers.delete(id);
      else timer.at = this.t + timer.every;
      timer.fn();
    }
    await flush();
  }
}
