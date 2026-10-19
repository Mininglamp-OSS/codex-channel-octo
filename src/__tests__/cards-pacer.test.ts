import { describe, expect, it } from "vitest";
import { parseRetryAfter } from "../cards/api.js";
import { normalizeOrigin } from "../cards/origin.js";
import { COOLDOWN_SLICE_MS, createPacer, type Pacer } from "../cards/pacer.js";
import {
  CLIENT_COOLDOWN_MAX_MS,
  DEBOUNCE_MS,
  EDIT_MAX_ATTEMPTS,
  EDIT_RETRY_WAITS_MS,
  backoffBase,
  clientCooldownMs,
  editRetryWaitMs,
  eligibilityDeadline,
  jitterFrom,
} from "../cards/retry-schedule.js";
import { cooldownComponents, createTelemetrySink, originRefOf, type MetricLine } from "../cards/telemetry.js";
import { manualTime, type ManualTime } from "./fixtures/card-write-harness.js";

const A = normalizeOrigin("https://api.example.com");
const OTHER = normalizeOrigin("https://other.example.com");

function rig(rngValues: number[] = [0]) {
  const time = manualTime();
  let i = 0;
  const rng = () => rngValues[Math.min(i++, rngValues.length - 1)];
  const lines: string[] = [];
  const sink = createTelemetrySink({ wall: time.wall, mono: time.clock, write: (l) => { lines.push(l); } });
  const pacer = createPacer({ clock: time.clock, timers: time.timers, rng, telemetry: { sink, originRef: originRefOf } });
  const metrics = () => lines.map((l) => JSON.parse(l.slice("[cards-metric] ".length)) as MetricLine & { name: string; value: number });
  return { time, pacer, metrics };
}

function eligibleAt(pacer: Pacer, time: ManualTime, at: number): boolean {
  return time.now() === at && pacer.gate(A).eligible;
}

describe("retry schedule constants and formulas (§3.5 / §5.2)", () => {
  it("pins the debounce, the edit attempt budget and the retry waits", () => {
    expect(DEBOUNCE_MS).toBe(800);
    expect(EDIT_MAX_ATTEMPTS).toBe(3);
    expect(EDIT_RETRY_WAITS_MS).toEqual([100, 250]);
    expect([1, 2, 3, 0].map(editRetryWaitMs)).toEqual([100, 250, undefined, undefined]);
  });

  it("B(n) doubles from 1 s and saturates at the 300 s cap", () => {
    expect([1, 2, 3, 9, 10, 11, 12, 100].map(backoffBase))
      .toEqual([1000, 2000, 4000, 256000, 300000, 300000, 300000, 300000]);
    expect(() => backoffBase(0)).toThrow();
    expect(() => backoffBase(1.5)).toThrow();
  });

  it("maps RNG samples to inclusive integer jitter [0, 500] and fails long on a broken RNG", () => {
    expect(jitterFrom(0)).toBe(0);
    expect(jitterFrom(0.999999)).toBe(500);
    expect(jitterFrom(0.5)).toBe(250);
    for (const bad of [NaN, -0.1, 1, 2, Infinity]) expect(jitterFrom(bad)).toBe(500);
  });

  it("T3: jitter endpoints J=0 and J=500 at n>=10 both give exactly 300000, never above", () => {
    for (const n of [10, 11, 12, 50]) {
      expect(clientCooldownMs(n, 0)).toBe(300000);
      expect(clientCooldownMs(n, 500)).toBe(300000);
    }
    expect(clientCooldownMs(9, 0)).toBe(256000);
    expect(clientCooldownMs(9, 500)).toBe(256500);
    expect(() => clientCooldownMs(1, 501)).toThrow();
  });

  it("T4: client cooldown never exceeds 300000 ms over n=1..12 including jitter", () => {
    for (let n = 1; n <= 12; n++) {
      for (const j of [0, 1, 250, 499, 500]) {
        const d = clientCooldownMs(n, j);
        expect(d).toBeLessThanOrEqual(CLIENT_COOLDOWN_MAX_MS);
        expect(d).toBe(Math.min(300000, 1000 * 2 ** Math.min(n - 1, 9) + j));
      }
    }
  });

  it("E = max(existingE, now + Dclient, now + Dserver); the server deadline is never truncated", () => {
    expect(eligibilityDeadline(0, 1000, 1000)).toBe(2000);
    expect(eligibilityDeadline(0, 1000, 1000, 901000)).toBe(901000);
    expect(eligibilityDeadline(5000, 1000, 1000, 1500)).toBe(5000);
    expect(eligibilityDeadline(0, 1000, 300000, 1000 + 900000)).toBe(901000);
    expect(eligibilityDeadline(0, 1000, 300000, 500)).toBe(301000);
  });
});

describe("pacer cooldown boundaries (controlled clock)", () => {
  it("T5: Retry-After 900 s (delta) blocks until exactly 900000 ms; it is not truncated to the client cap", async () => {
    const { time, pacer } = rig([0]);
    const t0 = time.now();
    pacer.observe429(A, 900_000, t0);
    expect(pacer.gate(A)).toEqual({ eligible: false, eligibleAtMono: t0 + 900_000 });
    await time.advanceTo(t0 + 300_000);
    expect(pacer.gate(A).eligible).toBe(false);
    await time.advanceTo(t0 + 899_999);
    expect(pacer.gate(A).eligible).toBe(false);
    await time.advanceTo(t0 + 900_000);
    expect(eligibleAt(pacer, time, t0 + 900_000)).toBe(true);
  });

  it("T5: Retry-After 900 s as an HTTP-date anchors to monotonic receipt and is honored in full", async () => {
    const { time, pacer } = rig([0]);
    const t0 = time.now();
    const date = new Date(time.wall.nowUtcMs() + 900_000).toUTCString();
    const retryAfterMs = parseRetryAfter(date, time.wall.nowUtcMs());
    expect(retryAfterMs).toBe(900_000);
    pacer.observe429(A, retryAfterMs, t0);
    await time.advanceTo(t0 + 899_999);
    expect(pacer.gate(A).eligible).toBe(false);
    await time.advanceTo(t0 + 900_000);
    expect(pacer.gate(A).eligible).toBe(true);
  });

  it("anchors the server deadline to the monotonic receipt time, not to the later observation", async () => {
    const { time, pacer } = rig([0]);
    const receipt = time.now();
    await time.advance(40);
    pacer.observe429(A, 10_000, receipt);
    expect(pacer.inspect(A)?.eligibleAtMono).toBe(receipt + 10_000);
  });

  it("T6: invalid Retry-After falls back to bounded client backoff", async () => {
    const { time, pacer, metrics } = rig([0]);
    for (const raw of ["soon", "-1", "1.5", "Mon, 99 Foo 2026 00:00:00 GMT", "12345678901"]) {
      expect(parseRetryAfter(raw, time.wall.nowUtcMs())).toBeUndefined();
    }
    const t0 = time.now();
    pacer.observe429(A, parseRetryAfter("soon", time.wall.nowUtcMs()), t0);
    expect(pacer.gate(A)).toEqual({ eligible: false, eligibleAtMono: t0 + 1000 });
    await time.advanceTo(t0 + 999);
    expect(pacer.gate(A).eligible).toBe(false);
    await time.advanceTo(t0 + 1000);
    expect(pacer.gate(A).eligible).toBe(true);
    const all = JSON.stringify(metrics());
    expect(all).not.toContain("soon");
    expect(metrics().some((m) => m.name === "cooldown_mandated_ms")).toBe(false);
    expect(metrics().find((m) => m.name === "cooldown_start_total")?.labels).toMatchObject({ code: "client_backoff" });
  });

  it("T7: wakes waiters by a single timer at E without polling", async () => {
    const { time, pacer } = rig([0]);
    const t0 = time.now();
    pacer.observe429(A, 900_000, t0);
    const woke: number[] = [];
    pacer.subscribeWake(A, () => woke.push(time.now()));
    pacer.subscribeWake(A, () => woke.push(time.now()));
    const before = time.scheduled();
    await time.advanceTo(t0 + 899_999);
    expect(woke).toEqual([]);
    await time.advanceTo(t0 + 900_000);
    expect(woke).toEqual([t0 + 900_000, t0 + 900_000]);
    // One timer per 60 s telemetry slice plus the wake itself: bounded, no spinning.
    expect(time.scheduled() - before).toBeLessThanOrEqual(Math.ceil(900_000 / COOLDOWN_SLICE_MS) + 1);
    expect(time.pending()).toBe(0);
    expect(pacer.inspect(A)?.waiters).toBe(0);
  });

  it("an unsubscribed waiter is never called; an eligible origin wakes on the next microtask", async () => {
    const { time, pacer } = rig([0]);
    let called = 0;
    pacer.observe429(A, undefined, time.now());
    const off = pacer.subscribeWake(A, () => called++);
    off();
    await time.advance(2000);
    expect(called).toBe(0);
    pacer.subscribeWake(A, () => called++);
    await time.advance(0);
    expect(called).toBe(1);
  });

  it("T17: success resets n without shortening an outstanding longer E; a later 429 extends E", async () => {
    const { time, pacer } = rig([0]);
    const t0 = time.now();
    pacer.observe429(A, 120_000, t0);
    pacer.observe429(A, undefined, t0);
    pacer.observe429(A, undefined, t0);
    expect(pacer.inspect(A)?.consecutive).toBe(3);
    pacer.observeSuccess(A);
    expect(pacer.inspect(A)).toMatchObject({ consecutive: 0, eligibleAtMono: t0 + 120_000 });
    expect(pacer.gate(A).eligible).toBe(false);
    await time.advanceTo(t0 + 120_000);
    expect(pacer.gate(A).eligible).toBe(true);
    // After the reset the next 429 restarts at B(1) and extends E from now.
    pacer.observe429(A, undefined, time.now());
    expect(pacer.inspect(A)).toMatchObject({ consecutive: 1, eligibleAtMono: t0 + 121_000 });
    pacer.observe429(A, 500_000, time.now());
    expect(pacer.inspect(A)?.eligibleAtMono).toBe(t0 + 620_000);
  });

  it("consecutive 429s escalate B(n) and reach the cap with jitter", () => {
    const { time, pacer } = rig([0.999999]);
    const t0 = time.now();
    const expected = [1500, 2500, 4500, 8500, 16500, 32500, 64500, 128500, 256500, 300000, 300000, 300000];
    for (let n = 1; n <= 12; n++) {
      pacer.observe429(normalizeOrigin(`https://n${n}.example.com`), undefined, t0);
    }
    for (let n = 1; n <= 12; n++) {
      const origin = normalizeOrigin(`https://n${n}.example.com`);
      expect(pacer.inspect(origin)?.eligibleAtMono).toBe(t0 + 1500);
    }
    for (let n = 1; n <= 12; n++) pacer.observe429(A, undefined, t0);
    expect(pacer.inspect(A)?.eligibleAtMono).toBe(t0 + Math.max(...expected));
    expect(Math.max(...expected)).toBe(300000);
  });
});

describe("origin identity and isolation", () => {
  it("T8: default port, upper-case host and IDNA spellings share one eligibility deadline", () => {
    const { time, pacer } = rig([0]);
    const spellings = ["https://API.Example.com", "https://api.example.com:443", "https://api.example.com/v1/base"]
      .map(normalizeOrigin);
    pacer.observe429(spellings[0], 30_000, time.now());
    for (const o of spellings) expect(pacer.gate(o).eligible).toBe(false);
    const idnA = normalizeOrigin("https://bücher.example");
    const idnB = normalizeOrigin("https://xn--bcher-kva.example:443");
    pacer.observe429(idnA, 30_000, time.now());
    expect(pacer.gate(idnB)).toEqual(pacer.gate(idnA));
    expect(pacer.gate(idnB).eligible).toBe(false);
    // The pacer re-derives identity from the key even for a hand-built spelling.
    expect(pacer.gate({ ...A, key: "https://API.EXAMPLE.COM:443" }).eligible).toBe(false);
  });

  it("T9: different origins (host or port) stay independent", () => {
    const { time, pacer } = rig([0]);
    pacer.observe429(A, 30_000, time.now());
    for (const o of [OTHER, normalizeOrigin("https://api.example.com:8443"), normalizeOrigin("https://api.example.net")]) {
      expect(pacer.gate(o).eligible).toBe(true);
    }
  });

  it("T10: retains only numeric timing state per origin; no Bot, credential or payload", () => {
    const { time, pacer } = rig([0]);
    pacer.observe429(A, 30_000, time.now());
    const view = pacer.inspect(A);
    expect(view).toBeDefined();
    for (const value of Object.values(view as object)) expect(["number", "boolean"]).toContain(typeof value);
    expect(Object.keys(view as object).sort()).toEqual(["consecutive", "cooling", "eligibleAtMono", "timerPending", "waiters"]);
    // The public surface accepts origins only; there is no parameter that could carry Bot identity.
    expect(pacer.observe429.length).toBe(3);
    expect(pacer.gate.length).toBe(1);
  });
});

describe("T20: cooldown telemetry through the injected sink", () => {
  it("counts one shared cooldown per origin once, with mandated and sliced intervals", async () => {
    const { time, pacer, metrics } = rig([0]);
    const t0 = time.now();
    // Two Bots on one origin observe 429s: still a single cooldown episode.
    pacer.observe429(A, 900_000, t0);
    pacer.observe429(normalizeOrigin("https://API.example.com:443"), 900_000, t0);
    await time.advanceTo(t0 + 900_000);
    const m = metrics();
    const ref = originRefOf(A.key);
    const starts = m.filter((x) => x.name === "cooldown_start_total");
    expect(starts).toHaveLength(1);
    expect(starts[0].labels).toMatchObject({ origin_ref: ref, code: "server_retry_after" });
    expect(m.filter((x) => x.name === "cooldown_end_total").map((x) => x.labels.code)).toEqual(["elapsed"]);
    const mandated = m.filter((x) => x.name === "cooldown_mandated_ms");
    expect(mandated.length).toBeGreaterThanOrEqual(1);
    expect(mandated[0].value).toBe(900_000);
    const slices = m.filter((x) => x.name === "cooldown_slice_ms");
    expect(slices.reduce((s, x) => s + x.value, 0)).toBe(900_000);
    expect(slices.every((x) => x.value <= COOLDOWN_SLICE_MS)).toBe(true);
    const comps = cooldownComponents(m as MetricLine[]).get(ref);
    expect(comps?.components).toHaveLength(1);
    const [s, e] = comps!.components[0];
    expect(e - s).toBe(900_000);
    // Only existing registry names, all origin-scoped, no Bot label.
    const names = new Set(m.map((x) => x.name));
    for (const n of names) {
      expect(["telemetry_heartbeat_total", "cooldown_start_total", "cooldown_end_total", "cooldown_slice_ms",
        "cooldown_mandated_ms"]).toContain(n);
    }
    expect(m.some((x) => "bot_ref" in (x.labels ?? {}))).toBe(false);
  });

  it("N5: slices after a server Retry-After extension carry the server_retry_after code", async () => {
    const { time, pacer, metrics } = rig([0]);
    const t0 = time.now();
    pacer.observe429(A, undefined, t0);
    await time.advance(500);
    pacer.observe429(A, 120_000, time.now());
    await time.advanceTo(t0 + 500 + 120_000);
    const slices = metrics().filter((x) => x.name === "cooldown_slice_ms");
    expect(slices[0].labels.code).toBe("client_backoff");
    expect(slices[0].value).toBe(500);
    expect(slices.slice(1).every((x) => x.labels.code === "server_retry_after")).toBe(true);
    expect(slices.reduce((sum, x) => sum + x.value, 0)).toBe(120_500);
    expect(metrics().filter((x) => x.name === "cooldown_start_total")).toHaveLength(1);
  });

  it("different origins each record their own cooldown; shutdown closes open cooldowns", async () => {
    const { time, pacer, metrics } = rig([0]);
    pacer.observe429(A, undefined, time.now());
    pacer.observe429(OTHER, 600_000, time.now());
    await time.advance(1000);
    pacer.close();
    const ends = metrics().filter((x) => x.name === "cooldown_end_total").map((x) => [x.labels.origin_ref, x.labels.code]);
    expect(ends).toEqual(expect.arrayContaining([[originRefOf(A.key), "elapsed"], [originRefOf(OTHER.key), "shutdown"]]));
    expect(metrics().filter((x) => x.name === "cooldown_start_total")).toHaveLength(2);
    // E is retained after shutdown: there is no bypass of the server deadline.
    expect(pacer.gate(OTHER).eligible).toBe(false);
    expect(time.pending()).toBe(0);
  });
});

// ─── XIN-2267 R2: timer arm overflow ────────────────────────────────────────

describe("E3: every timer arm stays within the native timer range", () => {
  const MAX_ARM = 2_147_483_647;

  /** Models Node's native rule: a delay above 2^31-1 fires after 1 ms (and is flagged here). */
  function overflowModel(time: ManualTime) {
    const arms: number[] = [];
    const timers = {
      setTimeout(callback: () => void, delayMs: number): unknown {
        arms.push(delayMs);
        return time.timers.setTimeout(callback, delayMs > MAX_ARM ? 1 : delayMs);
      },
      clearTimeout(handle: unknown): void { time.timers.clearTimeout(handle); },
    };
    return { timers, arms, overflows: () => arms.filter((d) => d > MAX_ARM).length };
  }

  it("a ten-digit delta Retry-After without telemetry arms no overflowing timer and never spins", async () => {
    const time = manualTime();
    const model = overflowModel(time);
    const pacer = createPacer({ clock: time.clock, timers: model.timers, rng: () => 0 });
    const t0 = time.now();
    const retryAfterMs = parseRetryAfter("9999999999", time.wall.nowUtcMs());
    expect(retryAfterMs).toBe(9_999_999_999_000);
    pacer.observe429(A, retryAfterMs, t0);
    expect(pacer.inspect(A)?.eligibleAtMono).toBe(t0 + 9_999_999_999_000);
    await time.advance(100);
    expect(model.arms).toHaveLength(1);
    // Ten full arms of virtual time: exactly one re-arm per elapsed arm, never an overflow.
    for (let i = 0; i < 10; i++) await time.advance(MAX_ARM);
    expect(model.overflows()).toBe(0);
    expect(model.arms.length).toBeLessThanOrEqual(11);
    expect(model.arms.every((d) => d <= MAX_ARM)).toBe(true);
    expect(pacer.gate(A)).toEqual({ eligible: false, eligibleAtMono: t0 + 9_999_999_999_000 });
  });

  it("a far-future HTTP-date beyond 24.8 days is honoured untruncated with bounded arms", async () => {
    const time = manualTime();
    const model = overflowModel(time);
    const pacer = createPacer({ clock: time.clock, timers: model.timers, rng: () => 0 });
    const t0 = time.now();
    const deltaMs = 30 * 24 * 3_600_000;
    const date = new Date(time.wall.nowUtcMs() + deltaMs).toUTCString();
    const retryAfterMs = parseRetryAfter(date, time.wall.nowUtcMs());
    expect(retryAfterMs).toBe(deltaMs);
    pacer.observe429(A, retryAfterMs, t0);
    const woke: number[] = [];
    pacer.subscribeWake(A, () => woke.push(time.now()));
    await time.advanceTo(t0 + deltaMs - 1);
    expect(pacer.gate(A).eligible).toBe(false);
    expect(woke).toEqual([]);
    await time.advanceTo(t0 + deltaMs);
    expect(pacer.gate(A).eligible).toBe(true);
    expect(woke).toEqual([t0 + deltaMs]);
    expect(model.overflows()).toBe(0);
    expect(model.arms.length).toBe(Math.ceil(deltaMs / MAX_ARM));
  });

  it("the telemetry slice path is also capped and overflow-free", async () => {
    const time = manualTime();
    const model = overflowModel(time);
    const sink = createTelemetrySink({ wall: time.wall, mono: time.clock, write: () => undefined });
    const pacer = createPacer({ clock: time.clock, timers: model.timers, rng: () => 0, telemetry: { sink, originRef: originRefOf } });
    pacer.observe429(A, 9_999_999_999_000, time.now());
    await time.advance(5 * 60_000);
    expect(model.overflows()).toBe(0);
    expect(model.arms.every((d) => d <= COOLDOWN_SLICE_MS)).toBe(true);
  });
});
