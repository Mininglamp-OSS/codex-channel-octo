/**
 * Content-free `[cards-metric]` sink (§3.1, §3.5–§3.8).
 *
 * The sink is a pure line producer: it owns no stream, timer, file or
 * network handle. The O-14 owner supplies a synchronous `write` function,
 * calls `heartbeat()` every 60 000 ms of monotonic time and calls
 * `closeSink()` last. A write return is never durability evidence.
 *
 * Every entry point is total: hostile labels, values, clocks and throwing
 * writers are contained and become closed codes; a thrown value is never
 * read, echoed or rethrown.
 */

import { randomBytes } from "node:crypto";
import { types } from "node:util";
import type { MonotonicClock, WallClock } from "./contracts.js";
import { isoUtc, utf8Bytes } from "./telemetry-grammar.js";
import {
  LABEL_KEYS, TELEMETRY_LIMITS as L, labelValueAllowed, metricRow,
  type EmitMetricName, type IntervalMetricName, type LabelSpec, type LossCode, type MetricRow,
  type TelemetryRejectCode,
} from "./telemetry-registry.js";

export const METRIC_LINE_PREFIX = "[cards-metric] ";

export type EmitResult = "emitted" | "emitted_degraded" | "not_emitted_empty" | "rejected" | "sink_failed";
/** O-11m: A = fixed anchor with sticky divergence validity; C = fixed anchor without the divergence check. B is withdrawn. */
export type ClockPolicy = "A" | "C";

export interface TelemetryHealth {
  readonly inc: string;
  readonly health: Readonly<Record<string, number>>;
  readonly pending: Readonly<Partial<Record<LossCode, number>>>;
}

export interface TelemetrySinkOptions {
  readonly wall: WallClock;
  readonly mono: MonotonicClock;
  /** Synchronously writes one serialized line plus newline; may buffer; must not be read as durable. */
  readonly write: (line: string) => void;
  readonly clockPolicy?: ClockPolicy;
}

export interface TelemetrySink {
  readonly inc: string;
  emit(name: EmitMetricName, labels: Readonly<Record<string, string>>, value: number): EmitResult;
  /** Rows #17 / #34; the value is derived from the interval, never supplied. */
  emitInterval(name: IntervalMetricName, labels: Readonly<Record<string, string>>, ivStartMono: number, ivEndMono: number): EmitResult;
  heartbeat(): EmitResult;
  /** Process drain only; idempotent; #33 is written only after a complete flush. */
  closeSink(): EmitResult;
  /** Diagnostic only; completeness never depends on it. Always returns undefined. */
  reportAsyncSinkError(): void;
  snapshotHealth(): TelemetryHealth;
}

export class TelemetryConfigError extends Error {
  constructor(readonly code: "unsupported_clock_policy" | "invalid_options") {
    super(`telemetry sink configuration rejected: ${code}`);
    this.name = "TelemetryConfigError";
  }
}

const validUtc = (u: unknown): u is number =>
  typeof u === "number" && Number.isFinite(u) && u >= 0 && u <= L.utcMax;
const validMono = (m: unknown): m is number =>
  typeof m === "number" && Number.isFinite(m) && m >= 0 && m <= L.monoMax;

interface PendingLoss { count: number; s: number; e: number; openEnd: boolean }

type LineFields = {
  v: 1; inc: string; name: string; labels: Record<string, string>; value: number;
  iv_start?: string; iv_end?: string; w_utc?: string; t_utc: string; t_mono: number;
};

export function createTelemetrySink(options: TelemetrySinkOptions): TelemetrySink {
  if (options === null || typeof options !== "object") throw new TelemetryConfigError("invalid_options");
  const policy = options.clockPolicy ?? "A";
  if (policy !== "A" && policy !== "C") throw new TelemetryConfigError("unsupported_clock_policy");
  const { wall, mono, write } = options;

  // 64 random bits per sink; no caller input selects or influences the incarnation id.
  const inc = "i" + randomBytes(8).toString("hex");
  const health: Record<string, number> = Object.create(null);
  const pending = new Map<LossCode, PendingLoss>();
  const bots = new Set<string>();
  const origins = new Set<string>();
  let dead = false;
  let closed = false;
  let seq = 0;
  let lastGoodD: number | null = null;
  /** Covered interval of the interval-row call in progress (loss span, V6-B1). */
  let curCover: [number, number] | null = null;

  const readMono = (): number => { try { return mono.nowMono(); } catch { return Number.NaN; } };
  const readWall = (): number => { try { return wall.nowUtcMs(); } catch { return Number.NaN; } };

  let anchorU = 0;
  let anchorM = 0;
  {
    const u0 = readWall();
    const m0 = readMono();
    if (!validUtc(u0) || !validMono(m0)) dead = true;
    else { anchorU = Math.floor(u0); anchorM = m0; }
  }

  const bump = (key: string, n = 1): void => { health[key] = (health[key] ?? 0) + n; };
  /** Single fixed construction anchor: d(x) = floor(w0) + floor(x − m0). */
  const d = (m: number): number => anchorU + Math.floor(m - anchorM);

  const serialize = (fields: LineFields, lineSeq: number): string => {
    const ordered: Record<string, unknown> = { v: fields.v, inc: fields.inc, seq: lineSeq, name: fields.name, labels: fields.labels, value: fields.value };
    if (fields.iv_start !== undefined) { ordered.iv_start = fields.iv_start; ordered.iv_end = fields.iv_end; }
    if (fields.w_utc !== undefined) ordered.w_utc = fields.w_utc;
    ordered.t_utc = fields.t_utc;
    ordered.t_mono = fields.t_mono;
    return METRIC_LINE_PREFIX + JSON.stringify(ordered);
  };

  /** Writes one line; seq is consumed only when the synchronous write returns. Throws on writer failure. */
  const rawWrite = (fields: LineFields, derived: number): void => {
    if (seq >= Number.MAX_SAFE_INTEGER) throw new RangeError("sequence exhausted");
    const line = serialize(fields, seq + 1);
    write(line + "\n");
    seq += 1;
    lastGoodD = derived;
  };

  const addPending = (code: LossCode, s: number, e: number, openEnd = false, n = 1): void => {
    const p = pending.get(code);
    if (!p) pending.set(code, { count: n, s, e, openEnd });
    else { p.count += n; p.s = Math.min(p.s, s); p.e = Math.max(p.e, e); p.openEnd ||= openEnd; }
  };

  const fieldsAt = (name: string, labels: Record<string, string>, value: number, m: number,
    extra?: Pick<LineFields, "iv_start" | "iv_end" | "w_utc">): LineFields => ({
    v: 1, inc, name, labels, value, ...extra, t_utc: isoUtc(d(m)), t_mono: Math.round(m * 1000) / 1000,
  });

  /** Flushes every pending loss in chunks ≤ 1000; true only if every chunk was written. */
  const flush = (m: number): boolean => {
    for (const [code, p] of pending) {
      while (p.count > 0) {
        const chunk = Math.min(L.counterMax, p.count);
        const e = p.openEnd ? Math.max(p.e, d(m)) : p.e;
        try {
          rawWrite(fieldsAt("telemetry_loss_total", { code, level: "warn" }, chunk, m,
            { iv_start: isoUtc(p.s), iv_end: isoUtc(e) }), d(m));
        } catch {
          bump("flush_failed");
          return false;
        }
        p.count -= chunk;
      }
      pending.delete(code);
    }
    return true;
  };

  const lossSpan = (m: number): [number, number] => curCover ?? [d(m), d(m)];

  /** Ordinary lines are written only after a fully successful flush; otherwise they become pending `sink_failed`. */
  const writeLine = (fields: LineFields, m: number): boolean => {
    if (!flush(m)) {
      const [a, b] = lossSpan(m);
      addPending("sink_failed", a, b);
      bump("sink_failed");
      bump("withheld_line");
      return false;
    }
    try {
      rawWrite(fields, d(m));
      return true;
    } catch {
      const [a, b] = lossSpan(m);
      addPending("sink_failed", a, b);
      bump("sink_failed");
      return false;
    }
  };

  const reject = (code: TelemetryRejectCode, lossBearing: boolean, m: number): "rejected" => {
    bump(`rejected_${code}`);
    const mOk = validMono(m) && !dead;
    if (lossBearing) {
      if (mOk) {
        const [a, b] = lossSpan(m);
        addPending(code, a, b);
      } else if (!dead) {
        const at = lastGoodD ?? anchorU;
        addPending(code, at, at, true);
      }
    }
    if (mOk) writeLine(fieldsAt("telemetry_rejected_total", { code, level: "warn" }, 1, m), m);
    return "rejected";
  };

  /** Label snapshot without running traps or getters (§3.6 step 2). */
  const snapshot = (labels: unknown): Record<string, unknown> | null => {
    if (labels === null || typeof labels !== "object" || Array.isArray(labels) || types.isProxy(labels)) return null;
    const proto: unknown = Object.getPrototypeOf(labels);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(labels);
    if (keys.length > L.maxLabelKeys) return null;
    const out: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") return null;
      const desc = Object.getOwnPropertyDescriptor(labels, key);
      if (!desc || !("value" in desc) || !desc.enumerable) return null;
      out[key] = desc.value;
    }
    return out;
  };

  const specOf = (r: MetricRow, key: string): LabelSpec | undefined =>
    (Object.hasOwn(r.required, key) ? r.required[key as keyof typeof r.required] : undefined)
    ?? (Object.hasOwn(r.optional, key) ? r.optional[key as keyof typeof r.optional] : undefined);

  /** Loss span of an interval-row call (§3.6); bounded and finite for malformed endpoints. */
  const coverFor = (r: MetricRow | undefined, ivS: unknown, ivE: unknown, m: number): [number, number] => {
    const now = d(m);
    const C = L.mandatedCeilMs;
    if (typeof ivS === "number" && typeof ivE === "number" && Number.isFinite(ivS) && Number.isFinite(ivE)) {
      const lo = Math.min(ivS, ivE);
      let hi = Math.max(ivS, ivE);
      if (r?.type === "mandated" && hi - lo > C) hi = lo + C;
      return [Math.max(Math.min(d(lo), now), now - L.backCoverMs), Math.min(Math.max(d(hi), now), now + C)];
    }
    if (r?.type === "slice") return [now - L.sliceRawMaxMs, now];
    if (r?.type === "mandated") return [now, now + C];
    return [now - L.sliceRawMaxMs, now + C];
  };

  const core = (entry: "emit" | "interval", name: unknown, labels: unknown, value: unknown, ivS?: unknown, ivE?: unknown): EmitResult => {
    if (dead) { bump("dead"); return "rejected"; }
    if (closed) { bump("closed"); return "rejected"; }
    const m = readMono();
    const r = metricRow(name);
    curCover = entry === "interval" && validMono(m) ? coverFor(r, ivS, ivE, m) : null;
    if (!r || r.entry !== entry) return reject("unknown_metric", true, m);                       // 1
    const lossBearing = r.lossBearing;
    const snap = snapshot(labels);                                                                 // 2
    if (!snap) return reject("invalid_labels", lossBearing, m);
    for (const key of Object.keys(snap)) {                                                         // 3
      if (!(LABEL_KEYS as readonly string[]).includes(key)) return reject("unknown_label", lossBearing, m);
      if (key === "level" || specOf(r, key) === undefined) return reject("label_not_allowed", lossBearing, m);
    }
    for (const key of Object.keys(r.required)) if (!Object.hasOwn(snap, key)) return reject("missing_label", lossBearing, m);
    for (const [key, v] of Object.entries(snap)) {                                                 // 4
      if (!labelValueAllowed(specOf(r, key)!, v)) return reject("invalid_label_value", lossBearing, m);
    }
    if (!validMono(m)) return reject("clock_invalid", lossBearing, m);                            // 5
    let degraded = false;
    let outValue: number;
    let extra: Pick<LineFields, "iv_start" | "iv_end"> | undefined;
    if (entry === "interval") {                                                                    // 6
      if (!(typeof ivS === "number" && typeof ivE === "number" && Number.isFinite(ivS) && Number.isFinite(ivE) && ivS >= 0)) {
        return reject("invalid_interval", lossBearing, m);
      }
      if (r.type === "slice" && !(ivS <= ivE && ivE <= m && ivE - ivS <= L.sliceRawMaxMs && ivS >= m - L.backCoverMs)) {
        return reject("invalid_interval", lossBearing, m);
      }
      if (r.type === "mandated" && !(m - L.mandatedStartSkewMs <= ivS && ivS <= m && m < ivE)) {
        return reject("invalid_interval", lossBearing, m);
      }
      let end = ivE;
      if (r.type === "mandated" && ivE - ivS > L.mandatedCeilMs) { end = ivS + L.mandatedCeilMs; degraded = true; }  // T2
      const ds = d(ivS);                                                                           // 7: derived value
      const de = d(end);
      if (de - ds === 0) { bump("not_emitted_empty"); return "not_emitted_empty"; }
      outValue = de - ds;
      extra = { iv_start: isoUtc(ds), iv_end: isoUtc(de) };
    } else {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return reject("invalid_value", lossBearing, m);
      if (r.type === "counter" && !(Number.isSafeInteger(value) && value >= 1 && value <= L.counterMax)) {
        return reject("invalid_value", lossBearing, m);
      }
      outValue = value;
      if (r.type === "duration_ms") {
        outValue = Math.ceil(value) + 0;                                                           // −0 → 0
        if (outValue > L.durationCeilMs) { outValue = L.durationCeilMs; degraded = true; }        // T2
      }
    }
    const lab: Record<string, string> = Object.create(null);                                       // 8
    for (const [key, v] of Object.entries(snap)) lab[key] = v as string;
    const botRef = lab.bot_ref;
    const originRef = lab.origin_ref;
    const newBot = botRef !== undefined && !bots.has(botRef) && bots.size >= L.maxBots;
    const newOrigin = originRef !== undefined && !origins.has(originRef) && origins.size >= L.maxOrigins;
    if (newBot && r.n === 29) { delete lab.bot_ref; degraded = true; }                            // T1
    else if (newBot || newOrigin) return reject("cardinality_exceeded", lossBearing, m);
    lab.level = r.level;                                                                           // 9: T3
    const sorted: Record<string, string> = {};
    for (const key of Object.keys(lab).sort()) sorted[key] = lab[key];
    const fields = fieldsAt(r.name, sorted, outValue, m, extra);
    // Sized with the widest possible seq, so a preceding loss flush can never push the written line over the cap.
    if (utf8Bytes(serialize(fields, Number.MAX_SAFE_INTEGER)) > L.lineCapBytes) return reject("line_too_long", lossBearing, m);
    if (!writeLine(fields, m)) return "sink_failed";
    if (lab.bot_ref !== undefined) bots.add(lab.bot_ref);
    if (lab.origin_ref !== undefined) origins.add(lab.origin_ref);
    return degraded ? "emitted_degraded" : "emitted";
  };

  /** Outer containment: a throw becomes a loss-bearing `internal_error`; the thrown value is never read. */
  const contain = (lossCover: (m: number) => [number, number] | null, run: () => EmitResult): EmitResult => {
    try {
      return run();
    } catch {
      bump("internal_error");
      try {
        const m = readMono();
        if (validMono(m) && !dead) {
          curCover = lossCover(m);
          reject("internal_error", true, m);
        }
      } catch {
        bump("internal_error_unrecorded");
      }
      return "rejected";
    } finally {
      curCover = null;
    }
  };

  const sink: TelemetrySink = {
    inc,
    emit: (name, labels, value) => contain(() => null, () => core("emit", name, labels, value)),
    emitInterval: (name, labels, ivStartMono, ivEndMono) =>
      // An internal fault loses the covered interval of the named row (its own loss span when the row is known).
      contain((m) => coverFor(metricRow(name), ivStartMono, ivEndMono, m), () => core("interval", name, labels, undefined, ivStartMono, ivEndMono)),
    heartbeat: () => contain(() => null, () => {
      if (dead || closed) return "rejected";
      const m = readMono();
      if (!validMono(m)) { bump("heartbeat_lost"); return "rejected"; }
      const w = readWall();
      if (!validUtc(w)) return reject("clock_invalid", true, m);
      // Fixed construction anchor under A and C: wall steps never re-anchor the derived timeline.
      return writeLine(fieldsAt("telemetry_heartbeat_total", { level: "info" }, 1, m, { w_utc: isoUtc(Math.floor(w)) }), m)
        ? "emitted" : "sink_failed";
    }),
    closeSink: () => contain(() => null, () => {
      if (dead || closed) return "rejected";
      const m = readMono();
      closed = true;
      if (!validMono(m)) {
        bump("rejected_clock_invalid");
        const at = lastGoodD ?? anchorU;
        addPending("clock_invalid", at, at, true);
        return "rejected";
      }
      return writeLine(fieldsAt("telemetry_close_total", { code: "process_shutdown", level: "info" }, 1, m), m)
        ? "emitted" : "sink_failed";
    }),
    reportAsyncSinkError: () => {
      try {
        if (dead || closed) return;
        const m = readMono();
        if (!validMono(m)) { bump("heartbeat_lost"); return; }
        const now = d(m);
        addPending("sink_failed", now - L.backCoverMs, now);
        bump("sink_failed");
      } catch {
        bump("internal_error");
      }
    },
    snapshotHealth: () => {
      const pendingCounts: Partial<Record<LossCode, number>> = {};
      for (const [code, p] of pending) pendingCounts[code] = p.count;
      return Object.freeze({ inc, health: Object.freeze({ ...health }), pending: Object.freeze(pendingCounts) });
    },
  };
  Object.freeze(sink);
  if (!dead) sink.heartbeat();                                                                     // construction beat (§3.8)
  return sink;
}
