/**
 * Closed batch-input record validators (§4.2, §4.4, §4.5).
 *
 * Raw size is checked before parsing; the strict WP-01 parser rejects
 * duplicate/prototype-sensitive keys and unsafe integers. Keys are closed,
 * optional fields are absent or valid, nothing is normalized. A failure
 * returns one closed rule and never echoes input bytes. Validated values are
 * fresh frozen plain objects holding the known fields only.
 */

import { isJsonObject, parseStrictJson } from "./protocol.js";
import type { JsonObject, JsonValue } from "./contracts.js";
import {
  ARTIFACT_REF_PATTERN, INC_PATTERN, PROCESS_REF_PATTERN, SHA40_PATTERN, TOKEN_PATTERN, isIsoUtc, processRefOf,
  utf8Bytes,
} from "./telemetry-grammar.js";
import { EXCLUSION_CODES, ORIGIN_REF_PATTERN, TELEMETRY_LIMITS, type ExclusionCode } from "./telemetry-registry.js";
import type { ClockPolicy } from "./telemetry-sink.js";
import type { EvalReason } from "./telemetry-evaluator.js";

export const RECORD_MAX_BYTES = 4096;

/** Closed `EvidenceRule` diagnostics (§4.5). */
export const EVIDENCE_RULES = [
  "unknown_field", "missing_field", "wrong_type", "null_value", "grammar", "too_long", "not_nfc", "forbidden_char",
  "secret_shape", "not_canonical_origin", "unknown_sub_id",
  "level_not_recordable", "level_not_attestable", "level_mismatch",
  "time_order", "span_exceeded",
  "binding_mismatch", "binding_missing", "na_requires_approval",
  "running_end_mismatch", "incarnation_overlap", "inc_duplicate", "process_ref_unknown", "process_ref_mismatch",
  "slot_duplicate", "exclusion_unrecorded",
  "record_too_large", "malformed_json", "depth_exceeded",
] as const;
export type EvidenceRule = (typeof EVIDENCE_RULES)[number];

export type RecordResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly rule: EvidenceRule };

export interface DeploymentSlot {
  readonly processRef: string;
  readonly slot: string;
  /** [P] v13: start of the slot's first incarnation; required at evaluation. */
  readonly firstStartUtc?: string;
  /** [P] v14: attested stop; required at evaluation iff the slot's last incarnation exited. */
  readonly stoppedUtc?: string;
}
export interface DeploymentRecord {
  readonly cohortRef: string;
  readonly candidateSha: string;
  readonly firstIncarnationStartUtc: string;
  readonly processes: readonly DeploymentSlot[];
  readonly sourceRef: string;
}

export type IncarnationExit = "clean" | "unclean" | "running";
export interface LivenessIncarnation {
  readonly inc?: string;
  readonly startUtc: string;
  readonly endUtc?: string;
  readonly clockPolicy?: ClockPolicy;
  readonly exit: IncarnationExit;
  /** [P] v13: per-slot ordinal assigned once at start; required at evaluation. */
  readonly ordinal?: number;
}
export interface LivenessProcess {
  readonly processRef: string;
  readonly incarnations: readonly LivenessIncarnation[];
}
export interface LivenessRecord {
  readonly batchId: string;
  readonly cohortRef: string;
  readonly sourceRef: string;
  readonly processes: readonly LivenessProcess[];
}

export type ExclusionMetric = "M-02" | "M-03";
export interface ExclusionRecord {
  readonly metric: ExclusionMetric;
  readonly batchId: string;
  readonly code: ExclusionCode;
  readonly originRef: string;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly durationMs: number;
  readonly excludedCount: number;
  readonly measurementRef: string;
}

export type BatchMetric = "M-02" | "M-03" | "M-04" | "M-05";
export interface BatchDeclaration {
  readonly batchId: string;
  readonly cohortRef: string;
  readonly metric: BatchMetric;
  readonly sequence: number;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly declaredAtUtc: string;
  readonly storeOracleRefs?: readonly string[];
}

export const MAX_STORE_ORACLE_REFS = 16;

class RuleError {
  constructor(readonly rule: EvidenceRule) {}
}
const fail = (rule: EvidenceRule): never => { throw new RuleError(rule); };

function guarded<T>(run: () => T): RecordResult<T> {
  try {
    return { ok: true, value: run() };
  } catch (err) {
    return { ok: false, rule: err instanceof RuleError ? err.rule : "malformed_json" };
  }
}

/** Raw size first, then the strict parser; the root must be an object. */
export function parseRecordText(raw: unknown, maxDepth: number, maxNodes: number): JsonObject {
  if (typeof raw !== "string") fail("wrong_type");
  if (utf8Bytes(raw as string) > RECORD_MAX_BYTES) fail("record_too_large");
  const parsed = parseStrictJson(raw as string, { maxDepth, maxNodes, unsafeIntegers: "reject" });
  if (!parsed.ok) fail(parsed.code === "depth_exceeded" ? "depth_exceeded" : "malformed_json");
  const value = (parsed as { value: JsonValue }).value;
  if (!isJsonObject(value)) fail("wrong_type");
  return value as JsonObject;
}

function closedKeys(o: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of Object.keys(o)) if (!required.includes(key) && !optional.includes(key)) fail("unknown_field");
  for (const key of required) if (!Object.hasOwn(o, key)) fail("missing_field");
}

function str(value: JsonValue | undefined, pattern: RegExp): string {
  if (value === null) fail("null_value");
  if (typeof value !== "string") fail("wrong_type");
  if (!pattern.test(value as string)) fail("grammar");
  return value as string;
}
function utc(value: JsonValue | undefined): string {
  if (value === null) fail("null_value");
  if (typeof value !== "string") fail("wrong_type");
  if (!isIsoUtc(value)) fail("grammar");
  return value as string;
}
function obj(value: JsonValue | undefined): JsonObject {
  if (!isJsonObject(value)) fail("wrong_type");
  return value as JsonObject;
}
function nonEmptyArray(value: JsonValue | undefined): readonly JsonValue[] {
  if (!Array.isArray(value) || value.length < 1) fail("wrong_type");
  return value as readonly JsonValue[];
}
const has = (o: JsonObject, key: string): boolean => Object.hasOwn(o, key);

function deploymentFrom(o: JsonObject): DeploymentRecord {
  closedKeys(o, ["cohortRef", "candidateSha", "firstIncarnationStartUtc", "processes", "sourceRef"]);
  const cohortRef = str(o.cohortRef, TOKEN_PATTERN);
  const candidateSha = str(o.candidateSha, SHA40_PATTERN);
  const firstIncarnationStartUtc = utc(o.firstIncarnationStartUtc);
  const sourceRef = str(o.sourceRef, ARTIFACT_REF_PATTERN);
  const slots = new Set<string>();
  const processes = nonEmptyArray(o.processes).map((entry) => {
    const s = obj(entry);
    closedKeys(s, ["processRef", "slot"], ["firstStartUtc", "stoppedUtc"]);
    const firstStartUtc = has(s, "firstStartUtc") ? utc(s.firstStartUtc) : undefined;
    const stoppedUtc = has(s, "stoppedUtc") ? utc(s.stoppedUtc) : undefined;
    const slot = str(s.slot, TOKEN_PATTERN);
    const processRef = str(s.processRef, PROCESS_REF_PATTERN);
    if (processRef !== processRefOf(cohortRef, slot)) fail("process_ref_mismatch");
    if (slots.has(slot)) fail("slot_duplicate");
    slots.add(slot);
    return Object.freeze({
      processRef, slot, ...(firstStartUtc === undefined ? {} : { firstStartUtc }),
      ...(stoppedUtc === undefined ? {} : { stoppedUtc }),
    });
  });
  return Object.freeze({ cohortRef, candidateSha, firstIncarnationStartUtc, processes: Object.freeze(processes), sourceRef });
}

/** `DeploymentRecord`: maxDepth 4, maxNodes 256. */
export function validateDeploymentRecord(raw: unknown): RecordResult<DeploymentRecord> {
  return guarded(() => deploymentFrom(parseRecordText(raw, 4, 256)));
}

const EXITS: readonly string[] = ["clean", "unclean", "running"];

function livenessFrom(o: JsonObject, deployment: DeploymentRecord | undefined): LivenessRecord {
  closedKeys(o, ["batchId", "cohortRef", "sourceRef", "processes"]);
  const batchId = str(o.batchId, TOKEN_PATTERN);
  const cohortRef = str(o.cohortRef, TOKEN_PATTERN);
  const sourceRef = str(o.sourceRef, ARTIFACT_REF_PATTERN);
  const incs = new Set<string>();
  const processes = nonEmptyArray(o.processes).map((entry) => {
    const pr = obj(entry);
    closedKeys(pr, ["processRef", "incarnations"]);
    const processRef = str(pr.processRef, PROCESS_REF_PATTERN);
    if (deployment && !deployment.processes.some((s) => s.processRef === processRef)) fail("process_ref_unknown");
    let prevEnd = -Infinity;
    const incarnations = nonEmptyArray(pr.incarnations).map((item) => {
      const i = obj(item);
      closedKeys(i, ["startUtc", "exit"], ["inc", "endUtc", "clockPolicy", "ordinal"]);
      let ordinal: number | undefined;
      if (has(i, "ordinal")) {
        if (typeof i.ordinal !== "number" || !Number.isSafeInteger(i.ordinal) || i.ordinal < 1) fail("grammar");
        ordinal = i.ordinal as number;
      }
      const inc = has(i, "inc") ? str(i.inc, INC_PATTERN) : undefined;
      let clockPolicy: ClockPolicy | undefined;
      if (has(i, "clockPolicy")) {
        if (i.clockPolicy !== "A" && i.clockPolicy !== "C") fail("grammar");
        clockPolicy = i.clockPolicy as ClockPolicy;
      }
      if (typeof i.exit !== "string" || !EXITS.includes(i.exit)) fail("grammar");
      const exit = i.exit as IncarnationExit;
      const startUtc = utc(i.startUtc);
      const endUtc = has(i, "endUtc") ? utc(i.endUtc) : undefined;
      if ((exit === "running") !== (endUtc === undefined)) fail("running_end_mismatch");
      const s = Date.parse(startUtc);
      const e = endUtc === undefined ? Infinity : Date.parse(endUtc);
      if (e < s) fail("time_order");
      if (s < prevEnd) fail("incarnation_overlap");
      prevEnd = e;
      if (inc !== undefined) {
        if (incs.has(inc)) fail("inc_duplicate");
        incs.add(inc);
      }
      return Object.freeze({
        ...(inc === undefined ? {} : { inc }), startUtc, ...(endUtc === undefined ? {} : { endUtc }),
        ...(clockPolicy === undefined ? {} : { clockPolicy }), exit, ...(ordinal === undefined ? {} : { ordinal }),
      });
    });
    return Object.freeze({ processRef, incarnations: Object.freeze(incarnations) });
  });
  return Object.freeze({ batchId, cohortRef, sourceRef, processes: Object.freeze(processes) });
}

/** `LivenessRecord`: maxDepth 6, maxNodes 512; with a deployment, every processRef must be a slot. */
export function validateLivenessRecord(raw: unknown, deployment?: DeploymentRecord): RecordResult<LivenessRecord> {
  return guarded(() => livenessFrom(parseRecordText(raw, 6, 512), deployment));
}

function exclusionFrom(o: JsonObject): ExclusionRecord {
  closedKeys(o, ["metric", "batchId", "code", "originRef", "startUtc", "endUtc", "durationMs", "excludedCount", "measurementRef"]);
  if (o.metric !== "M-02" && o.metric !== "M-03") fail("grammar");
  const batchId = str(o.batchId, TOKEN_PATTERN);
  if (typeof o.code !== "string" || !(EXCLUSION_CODES as readonly string[]).includes(o.code)) fail("grammar");
  const originRef = str(o.originRef, ORIGIN_REF_PATTERN);
  const startUtc = utc(o.startUtc);
  const endUtc = utc(o.endUtc);
  const measurementRef = str(o.measurementRef, ARTIFACT_REF_PATTERN);
  const { durationMs, excludedCount } = o;
  if (typeof durationMs !== "number" || !Number.isSafeInteger(durationMs)) fail("wrong_type");
  if (typeof excludedCount !== "number" || !Number.isSafeInteger(excludedCount) || (excludedCount as number) < 1) fail("wrong_type");
  if ((durationMs as number) > TELEMETRY_LIMITS.mandatedCeilMs) fail("grammar");
  if (durationMs !== Date.parse(endUtc) - Date.parse(startUtc) || (durationMs as number) < 1) fail("exclusion_unrecorded");
  return Object.freeze({
    metric: o.metric as ExclusionMetric, batchId, code: o.code as ExclusionCode, originRef, startUtc, endUtc,
    durationMs: durationMs as number, excludedCount: excludedCount as number, measurementRef,
  });
}

/** `ExclusionRecord`: maxDepth 2, maxNodes 64; `[start, end)`, durationMs === end − start in [1, 2 592 000 000]. */
export function validateExclusionRecord(raw: unknown): RecordResult<ExclusionRecord> {
  return guarded(() => exclusionFrom(parseRecordText(raw, 2, 64)));
}

const BATCH_METRICS: readonly string[] = ["M-02", "M-03", "M-04", "M-05"];

function declarationFrom(o: JsonObject): BatchDeclaration {
  closedKeys(o, ["batchId", "cohortRef", "metric", "sequence", "startUtc", "endUtc", "declaredAtUtc"], ["storeOracleRefs"]);
  const batchId = str(o.batchId, TOKEN_PATTERN);
  const cohortRef = str(o.cohortRef, TOKEN_PATTERN);
  if (typeof o.metric !== "string" || !BATCH_METRICS.includes(o.metric)) fail("grammar");
  const metric = o.metric as BatchMetric;
  if (typeof o.sequence !== "number") fail("wrong_type");
  if (!Number.isSafeInteger(o.sequence) || (o.sequence as number) < 1) fail("grammar");
  const startUtc = utc(o.startUtc);
  const endUtc = utc(o.endUtc);
  const declaredAtUtc = utc(o.declaredAtUtc);
  if (Date.parse(startUtc) >= Date.parse(endUtc)) fail("time_order");
  let storeOracleRefs: readonly string[] | undefined;
  if (has(o, "storeOracleRefs")) {
    if (metric !== "M-04") fail("grammar");
    if (!Array.isArray(o.storeOracleRefs)) fail("wrong_type");
    const refs = o.storeOracleRefs as readonly JsonValue[];
    if (refs.length > MAX_STORE_ORACLE_REFS) fail("too_long");
    storeOracleRefs = Object.freeze(refs.map((ref) => str(ref, ARTIFACT_REF_PATTERN)));
  }
  return Object.freeze({
    batchId, cohortRef, metric, sequence: o.sequence as number, startUtc, endUtc, declaredAtUtc,
    ...(storeOracleRefs === undefined ? {} : { storeOracleRefs }),
  });
}

const validatedDeclarations = new WeakSet<BatchDeclaration>();

/** `BatchDeclaration`: maxDepth 3, maxNodes 64; `storeOracleRefs` only on M-04, at most 16 (O-13 A). */
export function validateBatchDeclaration(raw: unknown): RecordResult<BatchDeclaration> {
  const r = guarded(() => declarationFrom(parseRecordText(raw, 3, 64)));
  if (r.ok) validatedDeclarations.add(r.value);
  return r;
}

/** True only for a declaration produced by `validateBatchDeclaration`; forged objects are never scored. */
export function isValidatedDeclaration(decl: unknown): decl is BatchDeclaration {
  return typeof decl === "object" && decl !== null && validatedDeclarations.has(decl as BatchDeclaration);
}

/**
 * Set-level declaration rules (§4.4): a declaration made at or after its
 * batch start is `undeclared_batch`; same-(cohort, metric) declarations that
 * overlap in time, share a batchId or sequence, or whose sequence order
 * disagrees with their time order are `overlapping_batch`.
 */
export function declarationSetReasons(decls: readonly BatchDeclaration[]): ReadonlyMap<string, readonly EvalReason[]> {
  const out = new Map<string, Set<EvalReason>>();
  const add = (d: BatchDeclaration, reason: EvalReason): void => {
    const set = out.get(d.batchId) ?? new Set<EvalReason>();
    set.add(reason);
    out.set(d.batchId, set);
  };
  for (const d of decls) if (Date.parse(d.declaredAtUtc) >= Date.parse(d.startUtc)) add(d, "undeclared_batch");
  for (let i = 0; i < decls.length; i++) {
    for (let j = i + 1; j < decls.length; j++) {
      const x = decls[i];
      const y = decls[j];
      if (x.batchId === y.batchId) { add(x, "overlapping_batch"); add(y, "overlapping_batch"); continue; }
      if (x.cohortRef !== y.cohortRef || x.metric !== y.metric) continue;
      const xs = Date.parse(x.startUtc), xe = Date.parse(x.endUtc), ys = Date.parse(y.startUtc), ye = Date.parse(y.endUtc);
      const overlap = xs < ye && ys < xe;
      const misordered = x.sequence === y.sequence || (x.sequence < y.sequence) !== (xs < ys);
      if (overlap || misordered) { add(x, "overlapping_batch"); add(y, "overlapping_batch"); }
    }
  }
  const frozen = new Map<string, readonly EvalReason[]>();
  for (const [id, set] of out) frozen.set(id, Object.freeze([...set].sort()));
  return frozen;
}
