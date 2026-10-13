import type { Clock, TimerHandle } from '../../src/seams/clock.js';

interface Timer { id: number; due: number; seq: number; callback: () => void }

/**
 * Deterministic Clock for layers 1–2. Timers are measured against the monotonic
 * time, so wall-clock jumps (jumpWall) never fire or skip a timer.
 */
export class FakeClock implements Clock {
  private wall: number;
  private mono: number;
  private timers: Timer[] = [];
  private nextId = 1;
  private seq = 0;

  constructor(opts: { now?: number; monotonic?: number } = {}) {
    this.wall = opts.now ?? 0;
    this.mono = opts.monotonic ?? 0;
  }

  now(): number { return this.wall; }
  monotonicNow(): number { return this.mono; }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.timers.push({ id, due: this.mono + Math.max(0, delayMs), seq: this.seq++, callback });
    return { id } as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle | null | undefined): void {
    if (!handle) return;
    const id = (handle as unknown as { id: number }).id;
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  /** Advance both clocks by ms, firing due timers in (deadline, scheduling) order. */
  advance(ms: number): void {
    if (ms < 0) throw new Error('FakeClock.advance: negative duration');
    const target = this.mono + ms;
    for (;;) {
      const next = this.timers
        .filter((t) => t.due <= target)
        .sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.wall += next.due - this.mono;
      this.mono = next.due;
      next.callback();
    }
    this.wall += target - this.mono;
    this.mono = target;
  }

  /** Move only the wall clock (e.g. NTP step); timers are unaffected. */
  jumpWall(deltaMs: number): void { this.wall += deltaMs; }

  pendingTimers(): number { return this.timers.length; }
}
