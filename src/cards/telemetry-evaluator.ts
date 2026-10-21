/**
 * WP-14 evaluators (§3.7, §3.8, §5): strict collection parsing, the opaque
 * evaluation receipt, liveness/history/stop identity, loss attribution and
 * M-05 tails, the evidence horizon, window and batch evaluation, batch
 * chains and M-01 coverage.
 *
 * Everything here is pure: inputs are values, outputs are frozen values.
 * Action signals are descriptions only — nothing here disables, pauses,
 * blocks, rolls back, writes, sends or schedules anything.
 */

import type { Diag } from "./contracts.js";
import { parseStrictJson } from "./protocol.js";
import {
  ACCEPTANCE_SUBIDS_V1, ATTESTABLE_LEVELS, type AcceptanceLevel,
} from "./telemetry-acceptance.js";
import {
  environmentRuntimesCovered, evidenceBindingValid, sameRuntime, validateEvidenceRecord, validateSourceAttestation,
  type EvidenceBinding, type EvidenceResult,
} from "./telemetry-evidence.js";
import {
  ARTIFACT_REF_PATTERN, COMMENT_REF_PATTERN, INC_PATTERN, TOKEN_PATTERN, fingerprint, isDomainUtc, isoUtc, originRefOf,
  utf8Bytes,
} from "./telemetry-grammar.js";
import {
  isValidatedDeclaration, validateDeploymentRecord, validateExclusionRecord, validateLivenessRecord,
  type BatchDeclaration, type BatchMetric, type DeploymentRecord, type ExclusionRecord, type LivenessRecord,
} from "./telemetry-records.js";
import {
  AUTHENTICATED_DISPOSITIONS, M01_CRITICAL_CODES, M05_CRITICAL_CODES, ORIGIN_REF_PATTERN, TELEMETRY_LIMITS as L,
  labelValueAllowed, metricRow, type Capability, type CriticalCode, type MetricName,
} from "./telemetry-registry.js";
import { assessSelectedOutput } from "./telemetry-selected-output.js";
import { METRIC_LINE_PREFIX, type ClockPolicy } from "./telemetry-sink.js";

const W = L.windowMs;
const GAP = L.gapMs;
const DIV = L.divergenceMs;
const HZN = L.horizonMs;
const C = L.mandatedCeilMs;
const R = L.backCoverMs;
const UTC_MAX = L.utcMax;

// ─── Public types ───────────────────────────────────────────────────────────

export type EvalReason =
  | "telemetry_loss" | "clock_divergence" | "incarnation_unclean" | "unexpected_incarnation"
  | "missing_liveness_evidence" | "missing_environment_evidence" | "liveness_identity_mismatch" | "liveness_invalid"
  | "binding_mismatch" | "binding_missing" | "drill_in_canary"
  | "exclusion_unrecorded" | "exclusion_out_of_batch" | "exclusion_overlap" | "exclusion_wrong_origin"
  | "non_excludable_exclusion" | "undeclared_batch" | "overlapping_batch"
  | "insufficient_samples" | "exclusion_over_limit" | "missing_clock" | "missing_ack_identity" | "missing_evidence"
  // Charter v24 M-05 case-table codes (binding_mismatch above is shared).
  | "unknown_case_id" | "duplicate_case_id" | "missing_case_id" | "outcome_mismatch";

const EVAL_REASONS: readonly EvalReason[] = [
  "telemetry_loss", "clock_divergence", "incarnation_unclean", "unexpected_incarnation", "missing_liveness_evidence",
  "missing_environment_evidence", "liveness_identity_mismatch", "liveness_invalid", "binding_mismatch", "binding_missing",
  "drill_in_canary", "exclusion_unrecorded", "exclusion_out_of_batch", "exclusion_overlap", "exclusion_wrong_origin",
  "non_excludable_exclusion", "undeclared_batch", "overlapping_batch", "insufficient_samples", "exclusion_over_limit",
  "missing_clock", "missing_ack_identity", "missing_evidence", "unknown_case_id", "duplicate_case_id", "missing_case_id",
  "outcome_mismatch",
];
const isEvalReason = (x: unknown): x is EvalReason => typeof x === "string" && (EVAL_REASONS as readonly string[]).includes(x);

/** One strictly parsed `[cards-metric]` line; `d` is the derived-timeline instant of `t_utc`. */
export interface MetricLine {
  readonly v: 1;
  readonly inc: string;
  readonly seq: number;
  readonly name: MetricName;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
  readonly iv_start?: string;
  readonly iv_end?: string;
  readonly w_utc?: string;
  readonly t_utc: string;
  readonly t_mono: number;
  readonly d: number;
}

/** Explicit ingestion receipt: the valid lines plus the sticky parse-fault state (NB2). */
export interface ParsedCollection {
  readonly lines: readonly MetricLine[];
  readonly parseFault: boolean;
}

export type ProblemKind = "instant" | "duration" | "count" | "gap" | "div";
export interface Problem {
  readonly kind: ProblemKind;
  readonly s: number;
  readonly e: number;
  readonly reason: EvalReason;
  readonly quarantine?: true;
  readonly scope?: "M-05";
  readonly seqGap?: true;
}

declare const receiptBrand: unique symbol;
/** Private, non-wire evaluation receipt; never serialized, never accepted from telemetry. */
export interface EvaluationReceipt { readonly [receiptBrand]: true }

export interface EvaluationInput {
  readonly collection: ParsedCollection;
  readonly liveness: readonly unknown[];
  readonly deployment: unknown;
  readonly cohortRef: unknown;
  readonly livenessBatchId: unknown;
  readonly evalUtc: unknown;
  /** Binding-derived `origin_ref` set (already derived from `EvidenceBinding.environments[].apiOrigin`). */
  readonly origins: readonly unknown[];
  readonly clockPolicy?: unknown;
  /** O-11l B startup grace: null, or an integer in [0, 600000]. */
  readonly graceMs?: unknown;
}

/** Optional scoring-time restatements; any disagreement with the receipt is `pending`. */
export interface ScoringCheck {
  readonly evalUtc?: number;
  readonly cohortRef?: string;
  readonly livenessBatchId?: string;
  readonly deployment?: unknown;
  readonly livenessCover?: ReadonlySet<string>;
  readonly origins?: readonly string[];
  readonly clockPolicy?: ClockPolicy;
  readonly graceMs?: number | null;
  readonly collection?: ParsedCollection;
  readonly liveness?: readonly unknown[];
}

export interface EvaluationInspection {
  readonly valid: boolean;
  readonly quarantined: boolean;
  readonly identityFaults: readonly EvalReason[];
  readonly cover: readonly string[];
  readonly problems: readonly Problem[];
}

export type SignalMetric = "M-01" | "M-02" | "M-03" | "M-04" | "M-05" | "completeness";
export type SignalScope =
  | { readonly kind: "capability"; readonly capability: Capability; readonly botRef?: string }
  | { readonly kind: "origin"; readonly originRef: string }
  | { readonly kind: "cohort"; readonly cohortRef: string; readonly capabilities: readonly Capability[] };
export type SignalAction = "disable_capability" | "pause_expansion" | "block_expansion_until_rerun";
/**
 * Closed reason union (v16-B). Critical disables keep their critical code; ordinary M-03/M-04 window pauses use
 * `window_threshold_pause`; M-05 cooldown pauses use `cooldown_pause`; completeness and batch blocks keep an
 * existing `EvalReason` (or `status_missing`); batch-chain pauses keep `consecutive_fail` / `consecutive_invalid`.
 */
export type SignalReason =
  | EvalReason | CriticalCode | "consecutive_fail" | "consecutive_invalid" | "status_missing"
  | "window_threshold_pause" | "cooldown_pause";

/** A truthful description of a justified action. WP-14 performs no side effects. */
export interface ActionSignal {
  readonly action: SignalAction;
  readonly metric: SignalMetric;
  readonly scope: SignalScope;
  readonly source: "observed";
  readonly atUtc: string;
  /** Required: a signal is never emitted without a compatible closed reason. */
  readonly reason: SignalReason;
  readonly batchId?: string;
}
/** `synthetic_drill`: segregated; never a verdict or evidence. The WP-17 consumer routes it to the real path. */
export interface DrillSignal {
  readonly action: "disable_capability";
  readonly scope: SignalScope;
  readonly source: "drill";
  readonly atUtc: string;
  readonly reason: "synthetic_drill";
}
export interface WindowEvaluation {
  readonly window: number;
  readonly signals: readonly ActionSignal[];
  readonly drills: readonly DrillSignal[];
  readonly completeness: "complete" | "incomplete" | "pending";
  readonly runtimeSignals: readonly { readonly code: "event_stream_halt"; readonly atUtc: string }[];
}

export type BatchStatus = "pass" | "fail" | "invalid" | "unverified" | "pending";
export interface LatencyCounts {
  readonly eligible: number;
  readonly within: number;
  readonly unacked: number;
  readonly excluded: number;
  readonly passRequired: number;
}
export interface AdmissionCounts {
  readonly authenticated: number;
  readonly accepted: number;
}
export interface BatchEvaluation {
  readonly batchId: string;
  readonly metric: BatchMetric;
  readonly status: BatchStatus;
  readonly reasons: readonly EvalReason[];
  readonly latency?: LatencyCounts;
  readonly admission?: AdmissionCounts;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

const P = (iso: string): number => Date.parse(iso);
const validEval = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= UTC_MAX;
const validOrigins = (x: unknown): x is readonly string[] =>
  Array.isArray(x) && x.length > 0 && x.every((o) => typeof o === "string" && ORIGIN_REF_PATTERN.test(o))
  && new Set(x).size === x.length;
const isToken = (x: unknown): x is string => typeof x === "string" && TOKEN_PATTERN.test(x);
const freezeAll = <T>(items: T[]): readonly T[] => Object.freeze(items);

/** Interval intersection with a half-open `[a, b)` window or batch (§5.4). */
export const intersects = Object.freeze({
  instant: (t: number, a: number, b: number): boolean => a <= t && t < b,
  duration: (s: number, e: number, a: number, b: number): boolean => s < b && e > a,
  count: (s: number, e: number, a: number, b: number): boolean => s < b && e >= a,
  gap: (p: number, q: number, a: number, b: number): boolean => p < b && q > a,
  div: (p: number, q: number, a: number, b: number): boolean => p < b && q >= a,
});
const touches = (pr: Problem, a: number, b: number): boolean => intersects[pr.kind](pr.s, pr.e, a, b);

const serializeOnce = (x: unknown): string | null => {
  try {
    const s = JSON.stringify(x);
    return typeof s === "string" ? s : null;
  } catch {
    return null;
  }
};
const viewOf = (x: unknown): unknown => {
  const s = serializeOnce(x);
  if (s === null) return null;
  try { return JSON.parse(s) as unknown; } catch { return null; }
};
const asRecord = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

// ─── Strict collection parsing (§3.7) ───────────────────────────────────────

const LINE_KEYS: readonly string[] = ["v", "inc", "seq", "name", "labels", "value", "iv_start", "iv_end", "w_utc", "t_utc", "t_mono"];
const INTERVAL_ROWS: readonly number[] = [17, 32, 34];
const genuineCollections = new WeakSet<ParsedCollection>();
const rawText = new WeakMap<MetricLine, string>();

function parseLine(line: string): MetricLine | null {
  if (!line.startsWith(METRIC_LINE_PREFIX) || utf8Bytes(line) > L.lineCapBytes) return null;
  const r = parseStrictJson(line.slice(METRIC_LINE_PREFIX.length), { maxDepth: 3, maxNodes: 64, unsafeIntegers: "reject" });
  if (!r.ok) return null;
  const o = asRecord(r.value);
  if (!o || Object.keys(o).some((k) => !LINE_KEYS.includes(k))) return null;
  const row = metricRow(o.name);
  const { v, inc, seq, value, t_mono: tMono, t_utc: tUtc } = o;
  if (v !== 1 || typeof inc !== "string" || !INC_PATTERN.test(inc) || typeof seq !== "number" || !Number.isSafeInteger(seq)
    || seq < 1 || !row || !isDomainUtc(tUtc) || typeof tMono !== "number" || !Number.isFinite(tMono) || tMono < 0
    || tMono > L.monoMax || typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const labels = asRecord(o.labels);
  if (!labels || labels.level !== row.level) return null;
  for (const key of Object.keys(labels)) {
    if (key === "level") continue;
    const spec = (Object.hasOwn(row.required, key) ? row.required[key as keyof typeof row.required] : undefined)
      ?? (Object.hasOwn(row.optional, key) ? row.optional[key as keyof typeof row.optional] : undefined);
    if (!spec || !labelValueAllowed(spec, labels[key])) return null;
  }
  for (const key of Object.keys(row.required)) if (!Object.hasOwn(labels, key)) return null;
  const interval = INTERVAL_ROWS.includes(row.n);
  if (interval) {
    if (!isDomainUtc(o.iv_start) || !isDomainUtc(o.iv_end) || P(o.iv_start) > P(o.iv_end)) return null;
  } else if (o.iv_start !== undefined || o.iv_end !== undefined) return null;
  if (row.n === 35 ? !isDomainUtc(o.w_utc) : o.w_utc !== undefined) return null;
  if ((row.type === "counter" || row.type === "losscount" || row.type === "heartbeat")
    && (!Number.isSafeInteger(value) || value < 1 || value > L.counterMax)) return null;
  if (row.type === "duration_ms" && (!Number.isSafeInteger(value) || value > L.durationCeilMs)) return null;
  if ((row.n === 17 || row.n === 34) && (!Number.isSafeInteger(value) || value < 1
    || value !== P(o.iv_end as string) - P(o.iv_start as string) || value > (row.n === 17 ? L.sliceRawMaxMs + 1 : C))) return null;
  if (row.n === 35 && value !== 1) return null;
  const copy: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) copy[key] = labels[key] as string;
  const parsed: MetricLine = Object.freeze({
    v: 1, inc, seq, name: row.name, labels: Object.freeze(copy), value,
    ...(interval ? { iv_start: o.iv_start as string, iv_end: o.iv_end as string } : {}),
    ...(row.n === 35 ? { w_utc: o.w_utc as string } : {}),
    t_utc: tUtc, t_mono: tMono, d: P(tUtc),
  });
  rawText.set(parsed, line);
  return parsed;
}

/**
 * Strict ingestion. Unrelated log lines are ignored. A malformed or torn
 * prefixed line, an overlong line or a non-string element sets the sticky
 * parse fault, which quarantines scoring; valid lines remain for confirmed
 * critical signals. No offending bytes are retained or echoed.
 */
export function parseCollection(lines: readonly unknown[]): ParsedCollection {
  const out: MetricLine[] = [];
  let parseFault = false;
  try {
    if (!Array.isArray(lines)) parseFault = true;
    else {
      for (const line of lines) {
        if (typeof line !== "string") { parseFault = true; continue; }
        if (!line.startsWith("[cards-metric]")) continue;
        let parsed: MetricLine | null = null;
        try { parsed = parseLine(line); } catch { parsed = null; }
        if (parsed) out.push(parsed);
        else parseFault = true;
      }
    }
  } catch {
    parseFault = true;
  }
  const collection: ParsedCollection = Object.freeze({ lines: freezeAll(out), parseFault });
  genuineCollections.add(collection);
  return collection;
}

// ─── Liveness, identity and history (§I, §3.8) ──────────────────────────────

interface Life { readonly s: number; readonly e: number }

/** Structural/time pre-check of the liveness view; null means evaluation prerequisites are missing (pending). */
function trustedLives(liveness: unknown, evalUtc: unknown, clockPolicy: unknown): Map<string, Life> | null {
  if (!validEval(evalUtc) || !Array.isArray(liveness) || liveness.length === 0 || (clockPolicy !== "A" && clockPolicy !== "C")) return null;
  const incs = new Map<string, Life>();
  try {
    for (const r0 of liveness) {
      const r = asRecord(r0);
      if (!r || !Array.isArray(r.processes) || r.processes.length === 0) return null;
      for (const p0 of r.processes) {
        const p = asRecord(p0);
        if (!p || !Array.isArray(p.incarnations) || p.incarnations.length === 0) return null;
        let prevEnd = -Infinity;
        for (const i0 of p.incarnations) {
          const i = asRecord(i0);
          if (!i || !isDomainUtc(i.startUtc) || (i.exit !== "clean" && i.exit !== "unclean" && i.exit !== "running")) return null;
          if ((i.clockPolicy ?? "A") !== clockPolicy) return null;
          if ((i.exit === "running") !== !Object.hasOwn(i, "endUtc")) return null;
          if (Object.hasOwn(i, "endUtc") && !isDomainUtc(i.endUtc)) return null;
          const s = P(i.startUtc);
          const e = i.exit === "running" ? evalUtc : P(i.endUtc as string);
          if (e < s || s < prevEnd || e > evalUtc) return null;
          prevEnd = e;
          if (i.inc !== undefined) {
            if (typeof i.inc !== "string" || !INC_PATTERN.test(i.inc) || incs.has(i.inc)) return null;
            incs.set(i.inc, { s, e });
          }
        }
      }
    }
  } catch {
    return null;
  }
  return incs;
}

/** v13/v14 per-slot history: attested start, contiguous ordinals, first-start anchor and stop anchor (I-H1…I-H5). */
function historyFaults(dep: DeploymentRecord, records: readonly LivenessRecord[], faults: Set<EvalReason>): void {
  const slots = dep.processes;
  if (slots.some((s) => s.firstStartUtc === undefined)) { faults.add("missing_liveness_evidence"); return; }
  const min = Math.min(...slots.map((s) => P(s.firstStartUtc as string)));
  if (P(dep.firstIncarnationStartUtc) !== min) faults.add("liveness_identity_mismatch");
  for (const s of slots) {
    for (const r of records) {
      for (const pr of r.processes) {
        if (pr.processRef !== s.processRef) continue;
        const incs = pr.incarnations;
        if (incs.some((i) => i.ordinal === undefined)) { faults.add("missing_liveness_evidence"); continue; }
        const ords = incs.map((i) => i.ordinal as number);
        for (let k = 1; k < ords.length; k++) if (ords[k] <= ords[k - 1]) faults.add("liveness_identity_mismatch");
        if (ords.some((o, k) => o !== k + 1)) faults.add("missing_liveness_evidence");
        const first = P(incs[0].startUtc);
        const declared = P(s.firstStartUtc as string);
        if (first > declared) faults.add("missing_liveness_evidence");
        if (first < declared) faults.add("liveness_identity_mismatch");
        const last = incs[incs.length - 1];
        if (last.exit === "running") {
          if (s.stoppedUtc !== undefined) faults.add("liveness_identity_mismatch");
        } else if (s.stoppedUtc === undefined) faults.add("missing_liveness_evidence");
        else if (P(s.stoppedUtc) > P(last.endUtc as string)) faults.add("missing_liveness_evidence");
        else if (P(s.stoppedUtc) < P(last.endUtc as string)) faults.add("liveness_identity_mismatch");
      }
    }
  }
}

interface Identity {
  readonly faults: readonly EvalReason[];
  readonly cover: readonly string[];
  readonly deployment: DeploymentRecord | null;
  readonly records: readonly LivenessRecord[];
}

function evaluationIdentity(liveness: readonly unknown[], cohortRef: string, depRaw: string | null, livenessBatchId: string): Identity {
  const faults = new Set<EvalReason>();
  const cover = new Map<string, number>();
  const records: LivenessRecord[] = [];
  let dep: DeploymentRecord | null = null;
  try {
    const d = depRaw === null || depRaw === "null" ? null : validateDeploymentRecord(depRaw);
    if (d === null || !d.ok) faults.add("missing_environment_evidence");
    else if (d.value.cohortRef !== cohortRef) faults.add("liveness_identity_mismatch");
    else dep = d.value;
    const batchIds = new Set<string>();
    for (const r of liveness) {
      const v = validateLivenessRecord(serializeOnce(r), dep ?? undefined);
      if (!v.ok) { faults.add(v.rule === "process_ref_unknown" ? "liveness_identity_mismatch" : "liveness_invalid"); continue; }
      records.push(v.value);
      if (v.value.cohortRef !== cohortRef) faults.add("liveness_identity_mismatch");
      batchIds.add(v.value.batchId);
      for (const pr of v.value.processes) cover.set(pr.processRef, (cover.get(pr.processRef) ?? 0) + 1);
    }
    if (batchIds.size > 1) faults.add("liveness_identity_mismatch");
    if (batchIds.size === 1 && !batchIds.has(livenessBatchId)) faults.add("liveness_identity_mismatch");
    if (dep) {
      for (const n of cover.values()) if (n > 1) faults.add("liveness_identity_mismatch");
      for (const s of dep.processes) if (!cover.has(s.processRef)) faults.add("missing_liveness_evidence");
      historyFaults(dep, records, faults);
    }
  } catch {
    faults.add("liveness_invalid");
  }
  return { faults: freezeAll([...faults].sort()), cover: freezeAll([...cover.keys()].sort()), deployment: dep, records: freezeAll(records) };
}

// ─── Receipt (§5.3) ─────────────────────────────────────────────────────────

interface ReceiptState {
  readonly valid: boolean;
  readonly evalUtc: number;
  readonly clockPolicy: unknown;
  readonly graceMs: unknown;
  readonly cohortRef: string | null;
  readonly livenessBatchId: string | null;
  readonly deploymentFp: string;
  readonly deployment: DeploymentRecord | null;
  readonly cover: readonly string[];
  readonly identityFaults: readonly EvalReason[];
  readonly livenessFp: string;
  readonly records: readonly LivenessRecord[];
  readonly collection: ParsedCollection | null;
  readonly lines: readonly MetricLine[];
  readonly problems: readonly Problem[];
  readonly originsFp: string | null;
  /** The supplied binding-origin set, sorted; empty when invalid. */
  readonly origins: readonly string[];
}

const receipts = new WeakMap<EvaluationReceipt, ReceiptState>();

const quarantineProblem: Problem = Object.freeze({ kind: "count", s: 0, e: UTC_MAX, reason: "telemetry_loss", quarantine: true });

/**
 * Validates the evaluation context and computes completeness problems,
 * binding everything scoring consumes into an opaque receipt (single view,
 * I-V). Invalid prerequisites produce a constant finite quarantine and an
 * unusable receipt: every window and batch scored through it is pending,
 * while confirmed valid critical lines still produce immediate disables.
 */
export function openEvaluation(input: EvaluationInput): EvaluationReceipt {
  const out: Problem[] = [];
  const src = asRecord(input) ?? {};
  const collection = genuineCollections.has(src.collection as ParsedCollection) ? (src.collection as ParsedCollection) : null;
  const lines = collection?.lines ?? freezeAll<MetricLine>([]);
  const evalUtc = src.evalUtc;
  const clockPolicy = src.clockPolicy === undefined ? "A" : src.clockPolicy;
  const graceMs = src.graceMs === undefined ? null : src.graceMs;
  const cohortRef = isToken(src.cohortRef) ? src.cohortRef : null;
  const livenessBatchId = isToken(src.livenessBatchId) ? src.livenessBatchId : null;
  const origins = src.origins;
  const livenessView = Array.isArray(src.liveness) ? viewOf(src.liveness) : null;
  const depRaw = serializeOnce(src.deployment ?? null);

  const listedLives = trustedLives(livenessView, evalUtc, clockPolicy);
  const ident = listedLives && cohortRef !== null && livenessBatchId !== null && Array.isArray(livenessView)
    ? evaluationIdentity(livenessView, cohortRef, depRaw, livenessBatchId) : null;
  const inputsValid = !!listedLives && !!ident && collection !== null && validOrigins(origins)
    && lines.every((o) => o.d <= (evalUtc as number))
    && (graceMs === null || (Number.isSafeInteger(graceMs) && (graceMs as number) >= 0 && (graceMs as number) <= L.maxGraceMs));

  if (!inputsValid || !ident || !listedLives || !collection) out.push(quarantineProblem);
  // An identity, coverage or history fault quarantines every window and batch; nothing may narrow any hold.
  else if (ident.faults.length > 0) out.push(quarantineProblem);
  else {
    computeProblems(out, {
      lines, parseFault: collection.parseFault, records: ident.records, listedLives, evalUtc: evalUtc as number,
      origins: origins as readonly string[], clockPolicy: clockPolicy as ClockPolicy, graceMs: graceMs as number | null,
    });
  }
  const receipt = Object.freeze(Object.create(null)) as EvaluationReceipt;
  receipts.set(receipt, Object.freeze({
    valid: inputsValid,
    evalUtc: validEval(evalUtc) ? evalUtc : Number.NaN,
    clockPolicy, graceMs, cohortRef, livenessBatchId,
    deploymentFp: fingerprint(depRaw), deployment: ident?.deployment ?? null,
    cover: ident?.cover ?? freezeAll<string>([]), identityFaults: ident?.faults ?? freezeAll<EvalReason>([]),
    livenessFp: fingerprint(livenessView), records: ident?.records ?? freezeAll<LivenessRecord>([]),
    collection, lines, problems: freezeAll(out),
    originsFp: validOrigins(origins) ? fingerprint([...origins].sort()) : null,
    origins: validOrigins(origins) ? freezeAll([...origins].sort()) : freezeAll<string>([]),
  }));
  return receipt;
}

interface ProblemInputs {
  readonly lines: readonly MetricLine[];
  readonly parseFault: boolean;
  readonly records: readonly LivenessRecord[];
  readonly listedLives: ReadonlyMap<string, Life>;
  readonly evalUtc: number;
  readonly origins: readonly string[];
  readonly clockPolicy: ClockPolicy;
  readonly graceMs: number | null;
}

const sameLine = (a: MetricLine, b: MetricLine): boolean => rawText.get(a) === rawText.get(b);

function computeProblems(out: Problem[], x: ProblemInputs): void {
  const { lines, records, listedLives, evalUtc, clockPolicy, graceMs } = x;
  let quarantined = false;
  const quarantine = (): void => { if (!quarantined) { quarantined = true; out.push(quarantineProblem); } };
  if (x.parseFault) quarantine();

  const byInc = new Map<string, MetricLine[]>();
  for (const o of lines) {
    const list = byInc.get(o.inc);
    if (list) list.push(o); else byInc.set(o.inc, [o]);
  }

  // Trusted acknowledgement pre-pass: classify every incarnation before any tail is bounded.
  const rejected = new Set<string>();
  const divergent = new Set<string>();
  for (const [inc, ls] of byInc) {
    const life = listedLives.get(inc);
    if (!life) { rejected.add(inc); continue; }
    const seqs = new Map<number, MetricLine>();
    for (const o of ls) {
      if (o.d < life.s || o.d > life.e) rejected.add(inc);
      const prev = seqs.get(o.seq);
      if (prev !== undefined && !sameLine(prev, o)) rejected.add(inc);
      seqs.set(o.seq, o);
    }
    const sq = [...seqs.values()].sort((p, q) => p.seq - q.seq);
    for (let k = 1; k < sq.length; k++) {
      const dm = sq[k].t_mono - sq[k - 1].t_mono;
      const dd = sq[k].d - sq[k - 1].d;
      if (dm < 0 || dd < 0 || Math.abs(dd - dm) > L.anchorToleranceMs) rejected.add(inc);
    }
    let diverged = false;
    for (const o of sq) {
      if (o.name !== "telemetry_heartbeat_total") continue;
      if (Math.abs(P(o.w_utc as string) - o.d) > DIV) diverged = true;
      if (clockPolicy === "A" && diverged) divergent.add(inc);
    }
  }
  const eligible = (o: MetricLine): boolean => {
    const life = listedLives.get(o.inc);
    return !x.parseFault && !!life && !rejected.has(o.inc) && !divergent.has(o.inc) && o.d >= life.s && o.d <= life.e;
  };
  for (const inc of rejected) if (listedLives.has(inc)) quarantine();

  // Eligible acknowledgement instants per origin, ascending (strictly-after-h lookups).
  const acks = new Map<string, number[]>();
  for (const o of lines) {
    if ((o.name === "card_send_total" || o.name === "card_edit_total") && o.labels.code === "acked" && eligible(o)) {
      const org = o.labels.origin_ref;
      const list = acks.get(org);
      if (list) list.push(o.d); else acks.set(org, [o.d]);
    }
  }
  for (const list of acks.values()) list.sort((p, q) => p - q);
  const cohortOrigins = new Set<string>(x.origins);
  for (const o of lines) if (o.labels.origin_ref !== undefined) cohortOrigins.add(o.labels.origin_ref);
  const firstAckAfter = (org: string, h: number): number => {
    const list = acks.get(org);
    if (!list) return Infinity;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] > h) hi = mid; else lo = mid + 1; }
    return lo < list.length ? list[lo] : Infinity;
  };
  /** Cohort unknown-cooldown tail (f, min(h + C, bound)] for M-05 (O-11q A). */
  const m05Tail = (f: number, h: number): void => {
    let bound = -Infinity;
    for (const org of cohortOrigins) bound = Math.max(bound, firstAckAfter(org, h));
    if (cohortOrigins.size === 0) bound = Infinity;
    out.push({ kind: "div", s: f, e: Math.max(f + 1, Math.min(h + C, bound)), reason: "telemetry_loss", scope: "M-05" });
  };

  const listed = new Set<string>();
  for (const rec of records) {
    for (const pr of rec.processes) {
      for (const i of pr.incarnations) {
        const s = P(i.startUtc);
        const e = i.endUtc !== undefined ? P(i.endUtc) : evalUtc;
        if (i.exit === "unclean") out.push({ kind: "duration", s, e, reason: "incarnation_unclean" });
        const own = i.inc !== undefined ? byInc.get(i.inc) : undefined;
        if (i.inc === undefined || !own) {
          // Zero collected lines or absent inc: lifetime gap plus the cohort tail, before continuing.
          out.push({ kind: "gap", s: s - 1, e: e + 1, reason: "telemetry_loss" });
          m05Tail(s - R, e);
          continue;
        }
        listed.add(i.inc);
        const bySeq = new Map<number, MetricLine>();
        const conflicts: MetricLine[] = [];
        for (const o of own) {
          const prev = bySeq.get(o.seq);
          if (prev === undefined) bySeq.set(o.seq, o);
          else if (!sameLine(prev, o)) conflicts.push(o);
        }
        const ls = [...bySeq.values()].sort((p, q) => p.t_mono - q.t_mono);
        const sq = [...bySeq.values()].sort((p, q) => p.seq - q.seq);
        for (let k = 1; k < sq.length; k++) {
          const dm = sq[k].t_mono - sq[k - 1].t_mono;
          const dd = sq[k].d - sq[k - 1].d;
          if (dm < 0 || dd < 0 || Math.abs(dd - dm) > L.anchorToleranceMs) quarantine();
        }
        if (sq[0].seq !== 1) {
          out.push({ kind: "div", s: s - R, e: sq[0].d, reason: "telemetry_loss", seqGap: true });
          m05Tail(s - R, sq[0].d);
        }
        for (let k = 1; k < sq.length; k++) {
          if (sq[k].seq !== sq[k - 1].seq + 1) {
            out.push({ kind: "div", s: sq[k - 1].d - R, e: sq[k].d, reason: "telemetry_loss", seqGap: true });
            m05Tail(sq[k - 1].d - R, sq[k].d);
          }
        }
        for (const c of conflicts) {
          out.push({ kind: "div", s: c.d - R, e: c.d, reason: "telemetry_loss", seqGap: true });
          m05Tail(c.d - R, c.d);
        }
        const activation = ls.find((o) => o.name === "capability_state_total");
        const activationD = activation ? activation.d : Infinity;
        // O-11l B: grace on the sink's own timeline from the first line, bounded by first activation.
        const excused = (q: number): boolean => graceMs !== null && q <= Math.min(ls[0].d + graceMs, activationD);
        if (ls[0].d - s > GAP) out.push({ kind: "gap", s, e: ls[0].d, reason: "telemetry_loss" });
        for (let k = 1; k < ls.length; k++) {
          const dm = ls[k].t_mono - ls[k - 1].t_mono;
          if (dm > GAP && !excused(ls[k - 1].d + dm)) out.push({ kind: "gap", s: ls[k - 1].d, e: ls[k - 1].d + dm, reason: "telemetry_loss" });
        }
        const last = ls[ls.length - 1];
        if (e - last.d > GAP) out.push({ kind: "gap", s: last.d, e, reason: "telemetry_loss" });
        const lastBySeq = sq[sq.length - 1];
        const closeMissing = i.exit === "clean" && !(lastBySeq.name === "telemetry_close_total" && last === lastBySeq);
        if (closeMissing) out.push({ kind: "div", s: lastBySeq.d - R, e: Math.max(e, lastBySeq.d + 1), reason: "telemetry_loss" });
        if (closeMissing || i.exit === "unclean") m05Tail(lastBySeq.d - R, Math.max(e, lastBySeq.d));
        if (i.exit === "running" && e - lastBySeq.d > GAP) m05Tail(lastBySeq.d - R, e);
        let prevHb: MetricLine | null = null;
        let diverged = false;
        for (const o of ls) {
          if (o.name !== "telemetry_heartbeat_total") continue;
          if (Math.abs(P(o.w_utc as string) - o.d) > DIV) diverged = true;
          if (clockPolicy === "A" && prevHb && diverged) out.push({ kind: "div", s: prevHb.d, e: o.d, reason: "clock_divergence" });
          prevHb = o;
        }
      }
    }
  }
  for (const [inc, ls] of byInc) {
    if (listed.has(inc)) continue;
    let s = Infinity;
    let e = -Infinity;
    for (const o of ls) { s = Math.min(s, o.d); e = Math.max(e, o.d); }
    out.push({ kind: "count", s, e, reason: "unexpected_incarnation" });
  }
  for (const o of lines) {
    if (o.name === "telemetry_loss_total") out.push({ kind: "count", s: P(o.iv_start as string), e: P(o.iv_end as string), reason: "telemetry_loss" });
  }
  for (let k = 0; k < out.length; k++) out[k] = Object.freeze(out[k]);
}

/** Read-only, content-free view of a receipt for diagnostics; null for a non-receipt. */
export function inspectEvaluation(receipt: EvaluationReceipt): EvaluationInspection | null {
  const r = receipts.get(receipt);
  if (!r) return null;
  return Object.freeze({
    valid: r.valid,
    quarantined: r.problems.some((p) => p.quarantine === true),
    identityFaults: r.identityFaults,
    cover: r.cover,
    problems: r.problems,
  });
}

/** The receipt state usable for scoring, or null (pending). Scoring restatements must equal the receipt's. */
function scoringState(receipt: EvaluationReceipt, check: ScoringCheck | undefined): ReceiptState | null {
  const r = receipts.get(receipt);
  if (!r || !r.valid) return null;
  try {
    const c = check ?? {};
    if (c.evalUtc !== undefined && c.evalUtc !== r.evalUtc) return null;
    if (c.cohortRef !== undefined && c.cohortRef !== r.cohortRef) return null;
    if (c.livenessBatchId !== undefined && c.livenessBatchId !== r.livenessBatchId) return null;
    if (c.clockPolicy !== undefined && c.clockPolicy !== r.clockPolicy) return null;
    if (c.graceMs !== undefined && c.graceMs !== r.graceMs) return null;
    if (c.collection !== undefined && c.collection !== r.collection) return null;
    if (c.liveness !== undefined && fingerprint(viewOf(c.liveness)) !== r.livenessFp) return null;
    if (c.deployment !== undefined && fingerprint(serializeOnce(c.deployment ?? null)) !== r.deploymentFp) return null;
    if (c.origins !== undefined && (!validOrigins(c.origins) || fingerprint([...c.origins].sort()) !== r.originsFp)) return null;
    if (c.livenessCover !== undefined) {
      if (!(c.livenessCover instanceof Set)) return null;
      const supplied = [...c.livenessCover].sort();
      if (fingerprint(supplied) !== fingerprint(r.cover)) return null;
    }
    return r;
  } catch {
    return null;
  }
}

// ─── Horizon (O-11o A) ──────────────────────────────────────────────────────

/** `[a, b)` is pending while an intersecting running incarnation has no line with d ≥ b + 62 000, until evalUtc ≥ b + 152 000. */
function horizonPending(a: number, b: number, r: ReceiptState): boolean {
  if (r.clockPolicy !== "A" && r.clockPolicy !== "C") return true;
  for (const rec of r.records) {
    for (const pr of rec.processes) {
      for (const i of pr.incarnations) {
        const s = P(i.startUtc);
        const e = i.endUtc !== undefined ? P(i.endUtc) : Infinity;
        if (!(s < b && e > a) || i.exit !== "running") continue;
        if (!r.lines.some((o) => o.inc === i.inc && o.d >= b + HZN) && r.evalUtc < b + HZN + GAP) return true;
      }
    }
  }
  return false;
}

// ─── Cooldown merge (§5.4, O-11f/g) ─────────────────────────────────────────

export interface CooldownWindowStats { readonly long: number; readonly cumulativeMs: number }
export interface OriginCooldown {
  readonly components: readonly (readonly [number, number])[];
  readonly windows: ReadonlyMap<number, CooldownWindowStats>;
  /** Windows meeting ≥ 3 components each ≥ 60 s, or ≥ 300 s cumulative. */
  readonly pauseWindows: readonly number[];
}

/** Per-origin union of #17/#34 intervals across incarnations and processes; a shared cooldown counts once. */
export function cooldownComponents(lines: readonly MetricLine[]): ReadonlyMap<string, OriginCooldown> {
  const byOrigin = new Map<string, [number, number][]>();
  for (const o of lines) {
    if (o.name !== "cooldown_slice_ms" && o.name !== "cooldown_mandated_ms") continue;
    const list = byOrigin.get(o.labels.origin_ref) ?? [];
    list.push([P(o.iv_start as string), P(o.iv_end as string)]);
    byOrigin.set(o.labels.origin_ref, list);
  }
  const res = new Map<string, OriginCooldown>();
  for (const [origin, iv] of byOrigin) {
    iv.sort((p, q) => p[0] - q[0]);
    const merged: [number, number][] = [];
    for (const [s, e] of iv) {
      const l = merged[merged.length - 1];
      if (l && s <= l[1]) l[1] = Math.max(l[1], e);
      else merged.push([s, e]);
    }
    const win = new Map<number, { long: number; cumulativeMs: number }>();
    const slot = (k: number): { long: number; cumulativeMs: number } => {
      let v = win.get(k);
      if (!v) { v = { long: 0, cumulativeMs: 0 }; win.set(k, v); }
      return v;
    };
    for (const [s, e] of merged) {
      if (e - s >= 60_000) slot(Math.floor(s / W)).long += 1;
      for (let k = Math.floor(s / W); k * W < e; k++) slot(k).cumulativeMs += Math.min(e, (k + 1) * W) - Math.max(s, k * W);
    }
    const pauseWindows = [...win].filter(([, v]) => v.long >= 3 || v.cumulativeMs >= 300_000).map(([k]) => k).sort((p, q) => p - q);
    const frozenWin = new Map<number, CooldownWindowStats>();
    for (const [k, v] of win) frozenWin.set(k, Object.freeze({ ...v }));
    res.set(origin, Object.freeze({
      components: freezeAll(merged.map(([s, e]) => Object.freeze([s, e] as const))), windows: frozenWin,
      pauseWindows: freezeAll(pauseWindows),
    }));
  }
  return res;
}

/** Canonical view: one line per (inc, seq); counts never follow transport multiplicity. */
function canonical(lines: readonly MetricLine[]): readonly MetricLine[] {
  const map = new Map<string, MetricLine>();
  for (const o of lines) map.set(`${o.inc}:${o.seq}`, o);
  return [...map.values()];
}
/** Stable full-record key: every parsed field, labels normalized to sorted entries; byte layout is irrelevant. */
const recordKey = (o: MetricLine): string => JSON.stringify([
  o.inc, o.seq, o.name, Object.keys(o.labels).sort().map((k) => [k, o.labels[k]]), o.value,
  o.iv_start ?? null, o.iv_end ?? null, o.w_utc ?? null, o.t_utc, o.t_mono,
]);
/**
 * Every distinct valid `critical_signal_total` record, in first-seen order, independent of the per-(inc, seq)
 * count canonicalization: a reused or conflicting seq never erases a critical observation, while identical
 * transport duplicates collapse to one.
 */
function criticalLines(lines: readonly MetricLine[]): readonly MetricLine[] {
  const map = new Map<string, MetricLine>();
  for (const o of lines) {
    if (o.name !== "critical_signal_total") continue;
    const key = recordKey(o);
    if (!map.has(key)) map.set(key, o);
  }
  return [...map.values()];
}
const sum = (lines: readonly MetricLine[], pred: (o: MetricLine) => boolean): number =>
  lines.reduce((acc, o) => (pred(o) ? acc + o.value : acc), 0);

// ─── Window evaluation (§5.5) ───────────────────────────────────────────────

const ALL_CAPS: readonly Capability[] = Object.freeze(["automatic", "display", "interaction"]);
const M04_CRITICAL: readonly string[] = ["duplicate_admission", "unauthorized_admission"];
const M05_CRITICAL: readonly string[] = M05_CRITICAL_CODES;
const capsOf = (lines: readonly MetricLine[]): readonly Capability[] =>
  freezeAll(ALL_CAPS.filter((c) => lines.some((o) => o.labels.capability === c)));

function criticalSignals(lines: readonly MetricLine[], a: number, b: number): {
  signals: ActionSignal[]; drills: DrillSignal[]; runtime: { code: "event_stream_halt"; atUtc: string }[];
} {
  const signals: ActionSignal[] = [];
  const drills: DrillSignal[] = [];
  const runtime: { code: "event_stream_halt"; atUtc: string }[] = [];
  for (const o of criticalLines(lines)) {
    if (!intersects.instant(o.d, a, b)) continue;
    const code = o.labels.code as CriticalCode;
    const capability = o.labels.capability as Capability;
    const botRef = o.labels.bot_ref;
    if (code === "event_stream_halt") { runtime.push(Object.freeze({ code, atUtc: o.t_utc })); continue; }
    if (code === "synthetic_drill") {
      drills.push(Object.freeze({
        action: "disable_capability", source: "drill", atUtc: o.t_utc, reason: "synthetic_drill",
        scope: Object.freeze({ kind: "capability", capability, ...(botRef === undefined ? {} : { botRef }) }),
      }));
      continue;
    }
    const metric: SignalMetric = M05_CRITICAL.includes(code) ? "M-05" : M04_CRITICAL.includes(code) ? "M-04" : "M-01";
    // M-04 critical disables interaction (§5.5); M-01/M-05 disable the labelled capability.
    const scopeCap: Capability = metric === "M-04" ? "interaction" : capability;
    signals.push(Object.freeze({
      action: "disable_capability", metric, source: "observed", atUtc: o.t_utc, reason: code,
      scope: Object.freeze({ kind: "capability", capability: scopeCap, ...(botRef === undefined ? {} : { botRef }) }),
    }));
  }
  return { signals, drills, runtime };
}

/**
 * Evaluates window k = `[k·600000, (k+1)·600000)` through a receipt.
 * Critical disables are computed first and are returned even while pending.
 */
export function windowEvaluation(k: number, receipt: EvaluationReceipt, check?: ScoringCheck): WindowEvaluation {
  const r = scoringState(receipt, check);
  const stored = receipts.get(receipt);
  const a = k * W;
  const b = a + W;
  const critLines = stored ? stored.lines
    : check?.collection !== undefined && genuineCollections.has(check.collection) ? check.collection.lines : [];
  const finite = Number.isSafeInteger(k) && validEval(a) && validEval(b);
  const crit = finite ? criticalSignals(critLines, a, b) : { signals: [], drills: [], runtime: [] };
  const pending = !r || !finite || horizonPending(a, b, r);
  const result = (completeness: WindowEvaluation["completeness"], extra: ActionSignal[]): WindowEvaluation => Object.freeze({
    window: k, signals: freezeAll([...crit.signals, ...extra]), drills: freezeAll(crit.drills), completeness,
    runtimeSignals: freezeAll(crit.runtime),
  });
  if (pending) return result("pending", []);
  const atUtc = isoUtc(b);
  const extra: ActionSignal[] = [];
  const lines = canonical(r.lines).filter((o) => intersects.instant(o.d, a, b));
  for (const [origin, c] of cooldownComponents(r.lines)) {
    if (c.pauseWindows.includes(k)) {
      extra.push(Object.freeze({
        action: "pause_expansion", metric: "M-05", source: "observed", atUtc, reason: "cooldown_pause",
        scope: Object.freeze({ kind: "origin", originRef: origin }),
      }));
    }
  }
  const cohortRef = r.cohortRef as string;
  const cohort = (capabilities: readonly Capability[]): SignalScope => Object.freeze({ kind: "cohort", cohortRef, capabilities });
  // M-03: ≥ 3 unreconciled sends older than 60 s, or ≥ 3 failed closure edits, in one window.
  for (const name of ["unreconciled_send_aged_total", "closure_edit_failed_total"] as const) {
    const hits = lines.filter((o) => o.name === name);
    if (sum(hits, () => true) >= 3) {
      extra.push(Object.freeze({
        action: "pause_expansion", metric: "M-03", source: "observed", atUtc, reason: "window_threshold_pause", scope: cohort(capsOf(hits)),
      }));
    }
  }
  // M-04: ≥ 3 dead letters or unresolved claims older than 60 s in one window.
  const m04 = lines.filter((o) => (o.name === "action_disposition_total" && o.labels.code === "dead_letter")
    || o.name === "unresolved_claim_aged_total");
  if (sum(m04, () => true) >= 3) {
    extra.push(Object.freeze({
      action: "pause_expansion", metric: "M-04", source: "observed", atUtc, reason: "window_threshold_pause", scope: cohort(["interaction"]),
    }));
  }
  // The block keeps the first (sorted) reason among the problems that make the window incomplete.
  const touching = [...new Set(r.problems.filter((p) => touches(p, a, b)).map((p) => p.reason))].sort();
  const incomplete = touching.length > 0;
  if (incomplete) {
    extra.push(Object.freeze({
      action: "block_expansion_until_rerun", metric: "completeness", source: "observed", atUtc, reason: touching[0], scope: cohort(ALL_CAPS),
    }));
  }
  return result(incomplete ? "incomplete" : "complete", extra);
}

/**
 * O-11o A: revision only toward caution — signals, drills and runtime halts are sticky; completeness never
 * returns to complete. Observations are unioned by their full identity (including `atUtc`), so only identical
 * observations collapse and a later or partial collection can never drop confirmed fault evidence.
 */
export function revise(prev: WindowEvaluation | null, next: WindowEvaluation): WindowEvaluation {
  if (!prev) return next;
  const union = <T>(a: readonly T[], b: readonly T[], key: (s: T) => string): T[] => {
    const seen = new Set(a.map(key));
    return [...a, ...b.filter((s) => !seen.has(key(s)))];
  };
  const signals = union(prev.signals, next.signals,
    (s) => JSON.stringify([s.action, s.metric, s.scope, s.source, s.atUtc, s.reason, s.batchId ?? null]));
  const drills = union(prev.drills, next.drills, (s) => JSON.stringify([s.scope, s.atUtc]));
  const runtimeSignals = union(prev.runtimeSignals, next.runtimeSignals, (s) => JSON.stringify([s.code, s.atUtc]));
  const rank = { pending: 0, complete: 1, incomplete: 2 } as const;
  const completeness = next.completeness === "pending" ? prev.completeness
    : rank[next.completeness] >= rank[prev.completeness] ? next.completeness : prev.completeness;
  return Object.freeze({
    ...next, signals: freezeAll(signals), drills: freezeAll(drills), completeness, runtimeSignals: freezeAll(runtimeSignals),
  });
}

// ─── Batch evaluation (§5.1–§5.3) ───────────────────────────────────────────

const METRIC_CAPS: Readonly<Record<BatchMetric, readonly Capability[]>> = Object.freeze({
  "M-02": freezeAll<Capability>(["automatic"]),
  "M-03": freezeAll<Capability>(["automatic", "interaction"]),
  "M-04": freezeAll<Capability>(["interaction"]),
  "M-05": ALL_CAPS,
});
const LATENCY = {
  "M-02": { obs: "first_frame_ms", unacked: "first_frame_unacked_total", excluded: "first_frame_excluded_total", deadlineMs: 3_000 },
  "M-03": { obs: "terminal_ms", unacked: "terminal_unacked_total", excluded: "terminal_excluded_total", deadlineMs: 5_000 },
} as const;
const MIN_SAMPLES = 30;
const MIN_ACCEPTED = 10;

export interface BatchOptions {
  readonly binding: EvidenceBinding;
  /** Raw `ExclusionRecord` texts recorded before scoring; an invalid record is `exclusion_unrecorded`. */
  readonly exclusions?: readonly unknown[];
  /** Set-level declaration reasons for this batch (see `declarationSetReasons`). */
  readonly declarationReasons?: readonly EvalReason[];
  readonly check?: ScoringCheck;
  /** M-05 only: the selected-output evidence opened for this exact declaration, receipt and binding. */
  readonly selectedOutput?: SelectedOutputEvidence;
}

const pendingBatch = (decl: BatchDeclaration): BatchEvaluation =>
  Object.freeze({ batchId: decl.batchId, metric: decl.metric, status: "pending", reasons: freezeAll<EvalReason>([]) });

/**
 * Exact receipt binding (§4.6, §5.3), shared by batch and M-01 scoring: a structurally valid binding with
 * at least one source runtime covering every environment runtime; the receipt deployment's candidate SHA;
 * the receipt's binding-origin set equal to the set derived from every environment `apiOrigin`; and an
 * environment for every `bot_ref` in the scored lines.
 */
function bindingReasons(r: ReceiptState, binding: unknown, scoped: readonly MetricLine[], reasons: Set<EvalReason>): void {
  if (!evidenceBindingValid(binding)) { reasons.add("binding_missing"); return; }
  if (binding.sourceRuntimes.length === 0 || !environmentRuntimesCovered(binding)) reasons.add("binding_missing");
  if (r.deployment && r.deployment.candidateSha !== binding.candidateSha) reasons.add("binding_mismatch");
  for (const o of scoped) if (o.labels.bot_ref !== undefined && !binding.environments.has(o.labels.bot_ref)) reasons.add("binding_missing");
  const derived = new Set<string>();
  try {
    for (const env of binding.environments.values()) derived.add(originRefOf(env.apiOrigin));
  } catch {
    reasons.add("binding_mismatch");
    return;
  }
  if (derived.size !== r.origins.length || r.origins.some((o) => !derived.has(o))) reasons.add("binding_mismatch");
}

/**
 * Validity reasons and status of one declared batch `[startUtc, endUtc)`.
 * Pending: horizon open or receipt unusable — not scored, no signal, not in any chain.
 */
export function evaluateBatch(decl: BatchDeclaration, receipt: EvaluationReceipt, options: BatchOptions): BatchEvaluation {
  if (!isValidatedDeclaration(decl)) {
    // A forged or unvalidated declaration is never scored; it fails closed.
    const forged = asRecord(decl as unknown) ?? {};
    return Object.freeze({
      batchId: isToken(forged.batchId) ? forged.batchId : "",
      metric: forged.metric as BatchMetric, status: "invalid", reasons: freezeAll<EvalReason>(["undeclared_batch"]),
    });
  }
  const r = scoringState(receipt, options?.check);
  if (!r || decl.cohortRef !== r.cohortRef) return pendingBatch(decl);
  const a = P(decl.startUtc);
  const b = P(decl.endUtc);
  if (!validEval(a) || !validEval(b) || a >= b || horizonPending(a, b, r)) return pendingBatch(decl);

  const reasons = new Set<EvalReason>(options.declarationReasons ?? []);
  const lines = canonical(r.lines);
  for (const pr of r.problems) if ((pr.scope === undefined || pr.scope === decl.metric) && touches(pr, a, b)) reasons.add(pr.reason);
  const inBatch = lines.filter((o) => intersects.instant(o.d, a, b));
  const critInBatch = criticalLines(r.lines).filter((o) => intersects.instant(o.d, a, b));
  if (critInBatch.some((o) => o.labels.code === "synthetic_drill")) reasons.add("drill_in_canary");
  for (const f of r.identityFaults) reasons.add(f);
  bindingReasons(r, options.binding, inBatch, reasons);

  let latency: LatencyCounts | undefined;
  let admission: AdmissionCounts | undefined;
  let failed = false;
  if (decl.metric === "M-02" || decl.metric === "M-03") {
    const spec = LATENCY[decl.metric];
    const excludedLines = inBatch.filter((o) => o.name === spec.excluded);
    exclusionReasons(decl, a, b, excludedLines, r.lines, options.exclusions ?? [], reasons);
    const observations = inBatch.filter((o) => o.name === spec.obs);
    const unacked = sum(inBatch, (o) => o.name === spec.unacked);
    const excluded = sum(excludedLines, () => true);
    const eligible = observations.length + unacked;
    const within = observations.filter((o) => o.value <= spec.deadlineMs).length;
    const passRequired = Math.floor((95 * eligible + 99) / 100);
    if (eligible < MIN_SAMPLES) reasons.add("insufficient_samples");
    if (100 * excluded > 10 * (eligible + excluded)) reasons.add("exclusion_over_limit");
    latency = Object.freeze({ eligible, within, unacked, excluded, passRequired });
    failed = within < passRequired;
  } else if (decl.metric === "M-04") {
    const authenticatedCodes: readonly string[] = AUTHENTICATED_DISPOSITIONS.A;
    const authenticated = sum(inBatch, (o) => o.name === "action_disposition_total" && authenticatedCodes.includes(o.labels.code));
    const accepted = sum(inBatch, (o) => o.name === "action_disposition_total" && o.labels.code === "admitted");
    if (authenticated < MIN_SAMPLES || accepted < MIN_ACCEPTED) reasons.add("insufficient_samples");
    if (!decl.storeOracleRefs || decl.storeOracleRefs.length === 0) reasons.add("missing_evidence");
    admission = Object.freeze({ authenticated, accepted });
    failed = critInBatch.some((o) => M04_CRITICAL.includes(o.labels.code));
  } else {
    // The closed registry carries no selected-output turn count: without bound v24 evidence M-05 stays fail-closed.
    const evidence = options.selectedOutput;
    if (evidence === undefined) reasons.add("insufficient_samples");
    else {
      const sel = selectedStates.get(evidence);
      if (!sel || sel.receipt !== receipt || sel.declaration !== decl || sel.bindingFp !== bindingFingerprint(options.binding)) {
        reasons.add("binding_mismatch");
      } else {
        for (const x of sel.reasons) reasons.add(x);
        failed = sel.criticals.length > 0;
      }
    }
    failed ||= critInBatch.some((o) => M05_CRITICAL.includes(o.labels.code));
  }
  const sorted = freezeAll([...reasons].sort());
  const status: BatchStatus = sorted.length > 0 ? "invalid" : failed ? "fail" : "pass";
  return Object.freeze({
    batchId: decl.batchId, metric: decl.metric, status, reasons: sorted,
    ...(latency ? { latency } : {}), ...(admission ? { admission } : {}),
  });
}

function exclusionReasons(
  decl: BatchDeclaration, a: number, b: number, excludedLines: readonly MetricLine[], allLines: readonly MetricLine[],
  rawRecords: readonly unknown[], reasons: Set<EvalReason>,
): void {
  const recs: ExclusionRecord[] = [];
  for (const raw of rawRecords) {
    const v = validateExclusionRecord(raw);
    if (!v.ok) { reasons.add("exclusion_unrecorded"); continue; }
    if (v.value.metric === decl.metric && v.value.batchId === decl.batchId) recs.push(v.value);
  }
  const keyOf = (originRef: string, code: string): string => `${originRef}|${code}`;
  for (const rec of recs) if (P(rec.startUtc) < a || P(rec.endUtc) > b) reasons.add("exclusion_out_of_batch");
  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      if (keyOf(recs[i].originRef, recs[i].code) === keyOf(recs[j].originRef, recs[j].code)
        && P(recs[i].startUtc) < P(recs[j].endUtc) && P(recs[j].startUtc) < P(recs[i].endUtc)) reasons.add("exclusion_overlap");
    }
  }
  const groups = new Map<string, number>();
  for (const o of excludedLines) {
    const k = keyOf(o.labels.origin_ref, o.labels.code);
    groups.set(k, (groups.get(k) ?? 0) + o.value);
    if (!recs.some((rec) => keyOf(rec.originRef, rec.code) === k && o.d >= P(rec.startUtc) && o.d < P(rec.endUtc))) {
      reasons.add("exclusion_unrecorded");
    }
  }
  for (const [k, v] of groups) {
    if (recs.filter((rec) => keyOf(rec.originRef, rec.code) === k).reduce((acc, rec) => acc + rec.excludedCount, 0) !== v) {
      reasons.add("exclusion_unrecorded");
    }
  }
  for (const rec of recs) if (!groups.has(keyOf(rec.originRef, rec.code))) reasons.add("exclusion_unrecorded");
  // A server_cooldown exclusion must lie inside the merged cooldown coverage of its own origin.
  const cooldowns = cooldownComponents(allLines);
  for (const rec of recs) {
    if (rec.code !== "server_cooldown") continue;
    const s = P(rec.startUtc);
    const e = P(rec.endUtc);
    const comps = cooldowns.get(rec.originRef)?.components ?? [];
    if (!comps.some(([cs, ce]) => cs <= s && e <= ce)) reasons.add("exclusion_wrong_origin");
  }
}

// ─── M-05 selected-output evidence (v16-A / Charter v24) ────────────────────

declare const selectedOutputBrand: unique symbol;
/** Opaque, immutable evidence context bound to one declaration, one receipt and one binding. */
export interface SelectedOutputEvidence { readonly [selectedOutputBrand]: true }

interface SelectedState {
  readonly receipt: EvaluationReceipt;
  readonly declaration: BatchDeclaration;
  readonly bindingFp: string;
  readonly reasons: readonly EvalReason[];
  readonly criticals: readonly ActionSignal[];
}
const selectedStates = new WeakMap<SelectedOutputEvidence, SelectedState>();

/** Canonical projection of a binding; an invalid binding never matches. */
function bindingFingerprint(binding: unknown): string {
  if (!evidenceBindingValid(binding)) return "invalid";
  const envs = [...binding.environments.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([bot, e]) => [bot, e.runtime.codexSdkVersion, e.runtime.codexCliVersion, e.runtime.nodeVersion, e.apiOrigin, e.profileHash, e.templateFingerprint ?? null]);
  const runtimes = binding.sourceRuntimes.map((r) => [r.codexSdkVersion, r.codexCliVersion, r.nodeVersion]);
  return fingerprint([binding.candidateSha, binding.frozenBaselineSha, runtimes, envs]);
}

export interface SelectedOutputInput {
  readonly declaration: BatchDeclaration;
  readonly receipt: EvaluationReceipt;
  readonly binding: EvidenceBinding;
  /** Raw header record (separate count of normal selected-output turns). */
  readonly header: unknown;
  /** Raw controlled-failure case records: exactly the six v24 case ids, once each. */
  readonly cases: readonly unknown[];
  /** Raw normal-turn card-caused findings; uncapped, each record validated (diagnostics stay ≤ 16). */
  readonly findings?: readonly unknown[];
}
export interface SelectedOutputOpening {
  readonly evidence: SelectedOutputEvidence;
  /** Closed, content-free diagnostics; at most 16. */
  readonly diagnostics: readonly Diag[];
  /** Existing M-05 critical disables for confirmed card-caused faults; never delayed by a horizon. */
  readonly criticals: readonly ActionSignal[];
}

/**
 * Validates and binds M-05 selected-output evidence for one declared batch and receipt, and returns an
 * opaque context for `evaluateBatch`. Each input field is read exactly once; nothing is retained except
 * closed reasons and critical signals. Signals are data only.
 */
export function openSelectedOutputEvidence(input: SelectedOutputInput): SelectedOutputOpening {
  // Each field is read exactly once into a local (a throwing getter is contained per field and its value is
  // never read); arrays are copied from that single value.
  const src = asRecord(input) ?? {};
  const readOnce = (key: string, copyArray: boolean): unknown => {
    try {
      const value = src[key];
      return copyArray && Array.isArray(value) ? Array.from(value as unknown[]) : value;
    } catch {
      return copyArray ? null : undefined;
    }
  };
  const declaration = readOnce("declaration", false);
  const receipt = readOnce("receipt", false);
  const binding = readOnce("binding", false);
  const header = readOnce("header", false);
  const cases = readOnce("cases", true);
  const findings = readOnce("findings", true);
  const decl = isValidatedDeclaration(declaration) ? declaration : null;
  const state = receipts.get(receipt as EvaluationReceipt);
  let assessment;
  if (decl === null || decl.metric !== "M-05") {
    assessment = { diagnostics: freezeAll([Object.freeze({ path: "/declaration", rule: "binding_mismatch" })]),
      reasons: freezeAll<EvalReason>(["binding_mismatch"]), criticals: freezeAll([]) };
  } else {
    let cooldowns: ReadonlyMap<string, OriginCooldown> | null = null;
    assessment = assessSelectedOutput({ header, cases, findings }, {
      declaration: decl,
      receiptGenuine: state !== undefined,
      cohortRef: state?.cohortRef ?? null,
      livenessBatchId: state?.livenessBatchId ?? null,
      evalUtc: state?.evalUtc ?? Number.NaN,
      deploymentCandidateSha: state?.deployment?.candidateSha ?? null,
      binding: evidenceBindingValid(binding) ? binding : null,
      cooldownObserved: (originRef, s, e) => {
        cooldowns ??= cooldownComponents(state?.lines ?? []);
        const comps = (cooldowns.get(originRef)?.components ?? []).filter(([cs, ce]) => cs <= e && ce >= s).length;
        const starts = canonical(state?.lines ?? []).filter((o) => o.name === "cooldown_start_total"
          && o.labels.origin_ref === originRef && o.d >= s && o.d <= e).length;
        return { components: comps, starts };
      },
    });
  }
  const criticals = freezeAll(assessment.criticals.map((c): ActionSignal => Object.freeze({
    action: "disable_capability", metric: "M-05", source: "observed", atUtc: c.atUtc, reason: c.code,
    scope: Object.freeze({ kind: "capability", capability: c.capability }),
  })));
  const evidence = Object.freeze(Object.create(null)) as SelectedOutputEvidence;
  if (decl !== null && state !== undefined) {
    selectedStates.set(evidence, Object.freeze({
      receipt: receipt as EvaluationReceipt, declaration: decl, bindingFp: bindingFingerprint(binding),
      reasons: assessment.reasons, criticals,
    }));
  }
  return Object.freeze({ evidence, diagnostics: assessment.diagnostics, criticals });
}

// ─── Batch chains (§5.6, O-9 A) ─────────────────────────────────────────────

export interface ChainEntry {
  readonly declaration: BatchDeclaration;
  /** Missing means no computed status: fails closed as `invalid` (`status_missing`). */
  readonly status?: BatchStatus;
  /** The batch's validity reasons (from `evaluateBatch`); an invalid batch without one fails closed as `status_missing`. */
  readonly reasons?: readonly EvalReason[];
}

/**
 * Batch-chain signals per (cohort, metric), ordered by declaration sequence.
 * Pending batches are skipped before either accumulator is touched; every
 * invalid batch blocks; two adjacent invalid M-02 batches pause; two valid
 * fails pause M-02/M-03 with invalid batches bridged and a valid pass resetting.
 */
export function batchSignals(entries: readonly ChainEntry[]): readonly ActionSignal[] {
  const out: ActionSignal[] = [];
  const groups = new Map<string, ChainEntry[]>();
  for (const entry of entries) {
    const key = `${entry.declaration.cohortRef}\0${entry.declaration.metric}`;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((p, q) => p.declaration.sequence - q.declaration.sequence);
    const { metric, cohortRef } = list[0].declaration;
    const scope: SignalScope = Object.freeze({ kind: "cohort", cohortRef, capabilities: METRIC_CAPS[metric] });
    let lastValid: BatchStatus | null = null;
    let prevInvalid = false;
    for (const { declaration: d, status, reasons } of list) {
      if (status === "pending") continue;
      const st: BatchStatus = status === undefined || status === "unverified" ? "invalid" : status;
      const base = { metric, scope, source: "observed" as const, atUtc: d.endUtc, batchId: d.batchId };
      if (st === "invalid") {
        const known = status === undefined ? [] : [...(Array.isArray(reasons) ? reasons : [])].filter(isEvalReason).sort();
        out.push(Object.freeze({ ...base, action: "block_expansion_until_rerun", reason: known[0] ?? "status_missing" }));
        if (metric === "M-02" && prevInvalid) out.push(Object.freeze({ ...base, action: "pause_expansion", reason: "consecutive_invalid" }));
        prevInvalid = true;
        continue;
      }
      prevInvalid = false;
      if (st === "fail" && lastValid === "fail" && (metric === "M-02" || metric === "M-03")) {
        out.push(Object.freeze({ ...base, action: "pause_expansion", reason: "consecutive_fail" }));
      }
      lastValid = st;
    }
  }
  return freezeAll(out);
}

// ─── Action-signal validator (v16-B) ────────────────────────────────────────

const SIGNAL_KEYS: readonly string[] = ["action", "metric", "scope", "source", "atUtc", "reason", "batchId"];
const M01_DISABLE: readonly string[] = (M01_CRITICAL_CODES as readonly string[]).filter((c) => !M04_CRITICAL.includes(c));
const DISABLE_REASONS: Readonly<Record<string, readonly string[]>> = { "M-01": M01_DISABLE, "M-04": M04_CRITICAL, "M-05": M05_CRITICAL };

function capsValid(x: unknown): x is readonly Capability[] {
  if (!Array.isArray(x) || x.length === 0) return false;
  const order = x.map((c) => ALL_CAPS.indexOf(c as Capability));
  return order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]));
}
const sameCaps = (x: readonly Capability[], y: readonly Capability[]): boolean => x.length === y.length && x.every((c, i) => c === y[i]);

function scopeKind(scope: unknown): SignalScope["kind"] | null {
  const s = asRecord(scope);
  if (!s) return null;
  const keys = Object.keys(s);
  if (s.kind === "capability") {
    return keys.every((k) => k === "kind" || k === "capability" || k === "botRef") && ALL_CAPS.includes(s.capability as Capability)
      && (s.botRef === undefined || (typeof s.botRef === "string" && /^b[0-9a-f]{16}$/.test(s.botRef))) ? "capability" : null;
  }
  if (s.kind === "origin") {
    return keys.length === 2 && typeof s.originRef === "string" && ORIGIN_REF_PATTERN.test(s.originRef) ? "origin" : null;
  }
  if (s.kind === "cohort") {
    return keys.length === 3 && isToken(s.cohortRef) && capsValid(s.capabilities) ? "cohort" : null;
  }
  return null;
}

/**
 * Pure fail-closed check of one `ActionSignal`: closed keys, a canonical UTC instant, a valid scope, and a
 * reason compatible with its action, metric family and window/batch kind. Unknown, missing or incompatible
 * reasons are invalid; drills (`synthetic_drill`) and runtime halts are never action signals.
 */
export function actionSignalValid(signal: unknown): signal is ActionSignal {
  try {
    const s = asRecord(signal);
    if (!s || Object.keys(s).some((k) => !SIGNAL_KEYS.includes(k)) || s.source !== "observed" || !isDomainUtc(s.atUtc)) return false;
    const kind = scopeKind(s.scope);
    const { action, metric, reason } = s;
    if (typeof reason !== "string" || kind === null) return false;
    const batch = s.batchId !== undefined;
    if (batch && !isToken(s.batchId)) return false;
    const caps = kind === "cohort" ? (s.scope as { capabilities: readonly Capability[] }).capabilities : [];
    switch (action) {
      case "disable_capability": {
        if (batch || kind !== "capability" || typeof metric !== "string" || !DISABLE_REASONS[metric]?.includes(reason)) return false;
        return metric !== "M-04" || (s.scope as { capability: string }).capability === "interaction";
      }
      case "pause_expansion":
        switch (reason) {
          case "cooldown_pause": return !batch && metric === "M-05" && kind === "origin";
          case "window_threshold_pause":
            return !batch && kind === "cohort" && (metric === "M-03" || (metric === "M-04" && sameCaps(caps, METRIC_CAPS["M-04"])));
          case "consecutive_fail":
            return batch && kind === "cohort" && (metric === "M-02" || metric === "M-03") && sameCaps(caps, METRIC_CAPS[metric]);
          case "consecutive_invalid":
            return batch && kind === "cohort" && metric === "M-02" && sameCaps(caps, METRIC_CAPS["M-02"]);
          default: return false;
        }
      case "block_expansion_until_rerun":
        if (kind !== "cohort") return false;
        if (metric === "completeness") return !batch && isEvalReason(reason) && sameCaps(caps, ALL_CAPS);
        return batch && (metric === "M-02" || metric === "M-03" || metric === "M-04" || metric === "M-05")
          && (isEvalReason(reason) || reason === "status_missing") && sameCaps(caps, METRIC_CAPS[metric]);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Resume needs revalidation (an `EvidenceRef`) plus one fresh valid pass after the signal's batch. The signal
 * must itself be a valid action signal whose metric and cohort match the declaration bound by its batchId.
 */
export function resumeAllowed(entries: readonly ChainEntry[], signal: ActionSignal, revalidationRef: unknown): boolean {
  if (typeof revalidationRef !== "string" || !(ARTIFACT_REF_PATTERN.test(revalidationRef) || COMMENT_REF_PATTERN.test(revalidationRef))) return false;
  if (!actionSignalValid(signal)) return false;
  if (signal.scope.kind !== "cohort" || signal.batchId === undefined) return false;
  const after = entries.find((e) => e.declaration.batchId === signal.batchId)?.declaration;
  if (!after || after.metric !== signal.metric || after.cohortRef !== signal.scope.cohortRef) return false;
  return entries.some((e) => e.declaration.metric === after.metric && e.declaration.cohortRef === after.cohortRef
    && e.declaration.sequence > after.sequence && e.status === "pass");
}

// ─── M-01 (§5.2) ────────────────────────────────────────────────────────────

export type RowVerdict = "pass" | "fail" | "unverified" | "n/a";
export interface M01RowResult {
  readonly subId: string;
  readonly declaredLevel: AcceptanceLevel;
  readonly verdict: RowVerdict;
}
export interface M01Evaluation {
  readonly status: "pass" | "fail" | "unverified";
  readonly rows: readonly M01RowResult[];
  readonly reasons: readonly (EvalReason | CriticalCode)[];
  /** Records rejected by validation or binding; content-free. */
  readonly rejected: readonly { readonly form: "record" | "attestation"; readonly diagnostics: readonly Diag[] }[];
}
export interface M01Input {
  readonly evidence: readonly unknown[];
  readonly attestations: readonly unknown[];
  readonly binding: EvidenceBinding;
  /** Supplies the DeploymentRecord and the O-12 critical-signal period. */
  readonly receipt?: EvaluationReceipt;
}

/** Per-row precedence: fail > unverified > (n/a with pass ⇒ unverified) > pass > approved n/a > unverified. */
function rowVerdict(results: readonly EvidenceResult[], passCovered: boolean): RowVerdict {
  if (results.includes("fail")) return "fail";
  if (results.includes("unverified")) return "unverified";
  const pass = results.includes("pass");
  const na = results.includes("n/a");
  if (pass && na) return "unverified";
  if (pass) return passCovered ? "pass" : "unverified";
  if (na) return "n/a";
  return "unverified";
}

/**
 * M-01 over the 94 P0 rows (P1 is independently gated and not scored here).
 * Attestation rows need a pass on every source runtime. Missing deployment,
 * binding coverage or any row evidence is `unverified`; any M-01-set
 * critical code in the O-12 period (from `firstIncarnationStartUtc`) fails.
 */
export function evaluateM01(input: M01Input): M01Evaluation {
  const reasons = new Set<EvalReason | CriticalCode>();
  const rejected: { form: "record" | "attestation"; diagnostics: readonly Diag[] }[] = [];
  const bindingOk = evidenceBindingValid(input?.binding);
  if (!bindingOk || input.binding.sourceRuntimes.length === 0 || !environmentRuntimesCovered(input.binding)) reasons.add("binding_missing");
  const byRow = new Map<string, { results: EvidenceResult[]; passRuntimes: Set<number> }>();
  const slot = (subId: string): { results: EvidenceResult[]; passRuntimes: Set<number> } => {
    let v = byRow.get(subId);
    if (!v) { v = { results: [], passRuntimes: new Set() }; byRow.set(subId, v); }
    return v;
  };
  if (bindingOk) {
    for (const raw of Array.isArray(input.evidence) ? input.evidence : []) {
      const v = validateEvidenceRecord(raw, input.binding);
      if (!v.ok) { rejected.push(Object.freeze({ form: "record", diagnostics: v.diagnostics })); continue; }
      slot(v.value.subId).results.push(v.value.result);
    }
    for (const raw of Array.isArray(input.attestations) ? input.attestations : []) {
      const v = validateSourceAttestation(raw, input.binding);
      if (!v.ok) { rejected.push(Object.freeze({ form: "attestation", diagnostics: v.diagnostics })); continue; }
      const entry = slot(v.value.subId);
      entry.results.push(v.value.result);
      if (v.value.result === "pass") {
        input.binding.sourceRuntimes.forEach((rt, idx) => {
          if (sameRuntime(rt, v.value)) entry.passRuntimes.add(idx);
        });
      }
    }
  }
  const rows: M01RowResult[] = [];
  for (const row of ACCEPTANCE_SUBIDS_V1) {
    if (row.priority !== "P0") continue;
    const entry = byRow.get(row.subId);
    const attested = (ATTESTABLE_LEVELS as readonly string[]).includes(row.declaredLevel);
    const covered = !attested || (bindingOk && input.binding.sourceRuntimes.every((_, idx) => entry?.passRuntimes.has(idx)));
    rows.push(Object.freeze({ subId: row.subId, declaredLevel: row.declaredLevel, verdict: rowVerdict(entry?.results ?? [], covered) }));
  }
  const state = input?.receipt ? receipts.get(input.receipt) : undefined;
  if (!state || !state.valid || !state.deployment) reasons.add("missing_environment_evidence");
  if (state) {
    const from = state.deployment ? P(state.deployment.firstIncarnationStartUtc) : -Infinity;
    const period = canonical(state.lines).filter((o) => o.d >= from);
    const m01Codes: readonly string[] = M01_CRITICAL_CODES;
    for (const o of criticalLines(state.lines)) {
      if (o.d >= from && m01Codes.includes(o.labels.code)) reasons.add(o.labels.code as CriticalCode);
    }
    if (state.valid) {
      // A receipt quarantined by identity, coverage or history faults never supports a pass.
      const scoped = new Set<EvalReason>(state.identityFaults);
      bindingReasons(state, input.binding, period, scoped);
      // "Zero critical codes" over the O-12 period is unverifiable where telemetry was lost in that period.
      const end = state.evalUtc + 1;
      if (state.problems.some((p) => p.reason === "telemetry_loss" && p.scope === undefined && touches(p, Math.max(from, 0), end))) {
        scoped.add("telemetry_loss");
      }
      for (const x of scoped) reasons.add(x);
    }
  }
  const criticalSeen = [...reasons].some((x) => (M01_CRITICAL_CODES as readonly string[]).includes(x));
  const status = criticalSeen || rows.some((x) => x.verdict === "fail") ? "fail"
    : reasons.size > 0 || rows.some((x) => x.verdict === "unverified") ? "unverified" : "pass";
  return Object.freeze({ status, rows: freezeAll(rows), reasons: freezeAll([...reasons].sort()), rejected: freezeAll(rejected) });
}
