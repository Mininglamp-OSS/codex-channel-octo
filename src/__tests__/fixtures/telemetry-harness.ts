/**
 * Synthetic WP-14 telemetry harness for tests only (never shipped: `src/__tests__`
 * is excluded from the build). Clocks are controlled; nothing touches the network.
 */

import {
  createTelemetrySink, originRefOf, evaluateBatch, inspectEvaluation, openEvaluation, parseCollection, processRefOf,
  validateBatchDeclaration, windowEvaluation,
  type BatchDeclaration, type BatchEvaluation, type ClockPolicy, type EnvironmentTuple, type EvidenceBinding, type TelemetrySink,
} from "../../cards/telemetry.js";

export const B = Date.parse("2026-10-15T08:00:00.000Z");
export const W = 600_000;
export const K = B / W;
export const C = 2_592_000_000;
export const ORIGIN = "https://api.example.com:443";
export const ORIGIN2 = "https://api2.example.com:443";
/** Binding-derived origin refs: the receipt origin set equals the binding's derived set (§5.3). */
export const O = originRefOf(ORIGIN);
export const O2 = originRefOf(ORIGIN2);
export const BOT = "b" + "4".repeat(16);
export const BOT2 = "b" + "5".repeat(16);
export const SHA = "a".repeat(40);
export const BASE_SHA = "b".repeat(40);
export const ART = "artifact:liv@sha256:" + "a".repeat(64);
export const COH = "review";
export const RT = Object.freeze({ codexSdkVersion: "0.142.3", codexCliVersion: "0.142.3", nodeVersion: "v22.11.0" });
export const PROFILE = "c".repeat(64);

export const iso = (t: number): string => new Date(B + t).toISOString();

export const BIND: EvidenceBinding = Object.freeze({
  candidateSha: SHA,
  frozenBaselineSha: BASE_SHA,
  sourceRuntimes: Object.freeze([RT]),
  environments: new Map<string, EnvironmentTuple>([
    [BOT, Object.freeze({ runtime: RT, apiOrigin: ORIGIN, profileHash: PROFILE })],
    [BOT2, Object.freeze({ runtime: RT, apiOrigin: ORIGIN2, profileHash: PROFILE })],
  ]),
});

export interface Harness {
  t: number;
  wallOffset: number;
  lines: string[];
  writes: string[];
  drop: (line: string) => boolean;
  fail: (line: string) => boolean;
  sink: TelemetrySink;
  at(t: number): void;
  beats(t: number): void;
}

/** Each harness sink draws its own random incarnation; fixtures read it back from `sink.inc`. */
export function harness(start = 0, clockPolicy: ClockPolicy = "A"): Harness {
  const h = { t: start, wallOffset: 0, lines: [] as string[], writes: [] as string[], drop: () => false, fail: () => false } as unknown as Harness;
  h.sink = createTelemetrySink({
    wall: { nowUtcMs: () => B + h.t + h.wallOffset },
    mono: { nowMono: () => 1000.5 + h.t },
    clockPolicy,
    write: (l) => {
      if (h.fail(l)) throw new Error("writer failure");
      h.writes.push(l);
      if (!h.drop(l)) h.lines.push(l.endsWith("\n") ? l.slice(0, -1) : l);
    },
  });
  h.at = (t) => {
    if (t < h.t) throw new Error("time moves forward only");
    h.t = t;
  };
  h.beats = (t) => {
    while (h.t + 60_000 <= t) {
      h.t += 60_000;
      h.sink.heartbeat();
    }
    h.t = t;
  };
  return h;
}

export const pr = (slot: string, cohort = COH): string => processRefOf(cohort, slot);

export interface IncSpec { inc?: string; startUtc: string; endUtc?: string; exit: string; ordinal?: number; clockPolicy?: string }
export const li = (h: Harness | null, s: number, e: number, exit: string, ordinal: number): IncSpec => ({
  ...(h ? { inc: h.sink.inc } : {}),
  startUtc: iso(s),
  ...(exit === "running" ? {} : { endUtc: iso(e) }),
  exit,
  ordinal,
});
export const rec = (slot: string, incs: IncSpec[], batchId = "b1", cohort = COH) => ({
  batchId, cohortRef: cohort, sourceRef: ART, processes: [{ processRef: pr(slot, cohort), incarnations: incs }],
});
export const dep = (slots: Record<string, [number, number?]>, cohort = COH, candidateSha = SHA) => ({
  cohortRef: cohort,
  candidateSha,
  firstIncarnationStartUtc: iso(Math.min(...Object.values(slots).map((v) => v[0]))),
  sourceRef: ART,
  processes: Object.entries(slots).map(([slot, [f, st]]) => ({
    processRef: pr(slot, cohort), slot, firstStartUtc: iso(f), ...(st === undefined ? {} : { stoppedUtc: iso(st) }),
  })),
});

export function declare(fields: {
  batchId?: string; metric: string; start: number; end: number; sequence?: number; declaredAt?: number;
  cohortRef?: string; storeOracleRefs?: string[];
}): BatchDeclaration {
  const v = validateBatchDeclaration(JSON.stringify({
    batchId: fields.batchId ?? "m",
    cohortRef: fields.cohortRef ?? COH,
    metric: fields.metric,
    sequence: fields.sequence ?? 1,
    startUtc: iso(fields.start),
    endUtc: iso(fields.end),
    declaredAtUtc: iso(fields.declaredAt ?? fields.start - 1000),
    ...(fields.storeOracleRefs ? { storeOracleRefs: fields.storeOracleRefs } : {}),
  }));
  if (!v.ok) throw new Error(`declaration rejected: ${v.rule}`);
  return v.value;
}

export function openFor(lines: string[], live: unknown[], D: unknown, evalT = 3_000_000, extra: Record<string, unknown> = {}) {
  return openEvaluation({
    collection: parseCollection(lines), liveness: live, deployment: D, cohortRef: COH, livenessBatchId: "b1",
    evalUtc: B + evalT, origins: [O, O2], ...extra,
  });
}

export interface Summary {
  w: string[];
  pause: boolean;
  batch: BatchEvaluation;
  validity: string[];
  m05: [number, number][];
  hold: boolean;
  q: boolean;
  disable: string[];
}

/** Mirrors the v15 probe summary: windows K+1..K+3 and an M-05 batch over [W, 4W). */
export function ev(lines: string[], live: unknown[], D: unknown, evalT = 3_000_000): Summary {
  const receipt = openFor(lines, live, D, evalT);
  const w = [1, 2, 3].map((k) => windowEvaluation(K + k, receipt));
  const batch = evaluateBatch(declare({ metric: "M-05", start: W, end: 4 * W }), receipt, { binding: BIND });
  const probs = inspectEvaluation(receipt)!.problems;
  const m05 = probs.filter((p) => p.scope === "M-05").map((p) => [p.s - B, p.e - B] as [number, number]);
  return {
    w: w.map((x) => x.completeness),
    pause: w.some((x) => x.signals.some((s) => s.metric === "M-05" && s.action === "pause_expansion")),
    batch,
    // M-05 batches always carry insufficient_samples (no selected-output count in the closed registry).
    validity: batch.reasons.filter((r) => r !== "insufficient_samples"),
    m05,
    hold: m05.some(([, e]) => e >= 200_000 + C),
    q: probs.some((p) => p.quarantine === true),
    disable: w.flatMap((x) => x.signals.filter((s) => s.action === "disable_capability").map((s) => String(s.reason))),
  };
}
export const closed = (r: Summary): boolean => r.w.every((c) => c !== "complete") && r.validity.length > 0;
export const done = (r: Summary): boolean => r.w.every((c) => c === "complete") && r.validity.length === 0;

/** Retry-After at O from `at` to 2500 s; every line lost; clean exit at `end`. */
export function retryAfter(start: number, at = 100_000, end = 200_000): Harness {
  const a = harness(start);
  a.drop = () => true;
  a.at(at);
  a.sink.emit("cooldown_start_total", { origin_ref: O, code: "server_retry_after" }, 1);
  a.sink.emitInterval("cooldown_mandated_ms", { origin_ref: O, code: "server_retry_after" }, 1000.5 + at, 1000.5 + 2_500_000);
  a.at(end);
  a.sink.closeSink();
  return a;
}
export const healthy = (s: number, e: number): Harness => {
  const h = harness(s);
  h.beats(e);
  h.sink.closeSink();
  return h;
};
export const running = (s: number, until = 3_000_000): Harness => {
  const h = harness(s);
  h.beats(until);
  return h;
};
