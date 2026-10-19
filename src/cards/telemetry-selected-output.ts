/**
 * M-05 selected-output evidence (v16-A, Charter v24): closed record validation and case predicates.
 *
 * Three flat record kinds, each a raw string under the v15 4096-byte cap, parsed by the WP-01
 * strict parser (maxDepth 2, maxNodes 64):
 * - one header: the separate count of normal selected-output turns and its evidence reference;
 * - one record per controlled-failure case, for exactly the six v24 case ids;
 * - any number of optional normal-turn findings of a confirmed card-caused parity mismatch or lost final
 *   (no findings cap is approved; every record is validated and every bound one becomes a critical).
 *
 * Every record carries the full binding block (candidate, frozen baseline, runtime, origin metadata,
 * fixture revision, harness identity, batch/cohort/liveness snapshot); nothing is inherited. Each
 * case is judged by its own predicate against the frozen-baseline oracle digests; no record carries
 * a self-reported verdict. Only closed codes, counts, booleans, digests and references are admitted.
 * Pure: the caller supplies the declaration, receipt facts, binding and collected cooldown view.
 */

import type { Diag, JsonObject, JsonValue } from "./contracts.js";
import { MAX_DIAGNOSTICS } from "./protocol.js";
import {
  FIXTURE_REVISION_PATTERN, HARNESS_IDENTITY_PATTERN, NODE_VERSION_PATTERN, SEMVER_PATTERN,
  TEMPLATE_FINGERPRINT_PATTERN, canonicalOriginRule, hasSecretShape, sameRuntime, type EvidenceBinding,
} from "./telemetry-evidence.js";
import type { EvalReason } from "./telemetry-evaluator.js";
import {
  ARTIFACT_REF_PATTERN, COMMENT_REF_PATTERN, SHA256_HEX_PATTERN, SHA40_PATTERN, TOKEN_PATTERN, isIsoUtc, originRefOf,
  utf8Bytes,
} from "./telemetry-grammar.js";
import { parseRecordText, type BatchDeclaration, type EvidenceRule } from "./telemetry-records.js";
import { CAPABILITIES, type Capability } from "./telemetry-registry.js";

/** The closed M-05 controlled-failure case set (Charter v24), validated by exact membership. */
export const CONTROLLED_FAILURE_CASE_IDS = Object.freeze([
  "partial_segment_delivery_failure",
  "all_segment_delivery_failure",
  "missing_message_identity",
  "host_network_card_api_outage_restored",
  "progress_card_send_edit_failure",
  "card_write_http_429_cooldown",
] as const);
export type ControlledFailureCaseId = (typeof CONTROLLED_FAILURE_CASE_IDS)[number];

/** Minimum separate count of normal selected-output turns (PRD4 §8; controlled-case turns never count). */
export const MIN_SELECTED_OUTPUT_TURNS = 30;

/** The five v24 case-table codes plus the existing v15 codes used by this boundary. */
export type SelectedOutputRule =
  | "unknown_case_id" | "duplicate_case_id" | "missing_case_id" | "outcome_mismatch" | "binding_mismatch"
  | "missing_evidence" | "insufficient_samples" | EvidenceRule;

const BATCH_REASON_RULES: ReadonlySet<string> = new Set([
  "unknown_case_id", "duplicate_case_id", "missing_case_id", "outcome_mismatch", "binding_mismatch", "insufficient_samples",
]);

export type CriticalFindingCode = "output_parity_mismatch" | "card_lost_final";
export interface CardCausedCritical {
  readonly code: CriticalFindingCode;
  readonly capability: Capability;
  readonly atUtc: string;
}

/** Facts the evaluator supplies from the declaration, the receipt and the binding. */
export interface SelectedOutputEnvironment {
  readonly declaration: BatchDeclaration;
  readonly receiptGenuine: boolean;
  readonly cohortRef: string | null;
  readonly livenessBatchId: string | null;
  readonly evalUtc: number;
  readonly deploymentCandidateSha: string | null;
  readonly binding: EvidenceBinding | null;
  /** Merged cooldown components and #16 starts for an origin intersecting the closed interval [s, e]. */
  readonly cooldownObserved: (originRef: string, s: number, e: number) => { readonly components: number; readonly starts: number };
}

export interface SelectedOutputAssessment {
  readonly diagnostics: readonly Diag[];
  readonly reasons: readonly EvalReason[];
  readonly criticals: readonly CardCausedCritical[];
}

// ─── Field grammar ──────────────────────────────────────────────────────────

type Check = (v: JsonValue) => EvidenceRule | null;
const str = (re: RegExp, max: number): Check => (v) => {
  if (typeof v !== "string") return "wrong_type";
  if (utf8Bytes(v) > max) return "too_long";
  return re.test(v) ? null : "grammar";
};
const int = (min: number): Check => (v) => {
  if (typeof v !== "number") return "wrong_type";
  return Number.isSafeInteger(v) && v >= min ? null : "grammar";
};
const bool: Check = (v) => (typeof v === "boolean" ? null : "wrong_type");
const oneOf = (values: readonly string[], max: number): Check => (v) => {
  if (typeof v !== "string") return "wrong_type";
  if (utf8Bytes(v) > max) return "too_long";
  return values.includes(v) ? null : "grammar";
};
const utc: Check = (v) => (typeof v !== "string" ? "wrong_type" : isIsoUtc(v) ? null : "grammar");
const origin: Check = (v) => {
  if (typeof v !== "string") return "wrong_type";
  if (utf8Bytes(v) > 280) return "too_long";
  return canonicalOriginRule(v);
};
const template: Check = (v) => {
  const base = str(TEMPLATE_FINGERPRINT_PATTERN, 150)(v);
  if (base !== null) return base;
  return hasSecretShape(TEMPLATE_FINGERPRINT_PATTERN.exec(v as string)![1]) ? "secret_shape" : null;
};
const ARTIFACT = str(ARTIFACT_REF_PATTERN, 145);
const EVIDENCE_REF = str(new RegExp(`${ARTIFACT_REF_PATTERN.source}|${COMMENT_REF_PATTERN.source}`), 145);
const DIGEST = str(SHA256_HEX_PATTERN, 64);

const BIND: Readonly<Record<string, Check>> = {
  batchId: str(TOKEN_PATTERN, 64),
  cohortRef: str(TOKEN_PATTERN, 64),
  livenessBatchId: str(TOKEN_PATTERN, 64),
  candidateSha: str(SHA40_PATTERN, 40),
  frozenBaselineSha: str(SHA40_PATTERN, 40),
  codexSdkVersion: str(SEMVER_PATTERN, 64),
  codexCliVersion: str(SEMVER_PATTERN, 64),
  nodeVersion: str(NODE_VERSION_PATTERN, 24),
  apiOrigin: origin,
  profileHash: DIGEST,
  templateFingerprint: template,
  fixtureRevision: str(FIXTURE_REVISION_PATTERN, 105),
  harnessIdentity: str(HARNESS_IDENTITY_PATTERN, 129),
};
const BIND_KEYS = Object.keys(BIND);
const OPTIONAL = new Set(["templateFingerprint"]);

const HEADER: Readonly<Record<string, Check>> = {
  ...BIND, startUtc: utc, endUtc: utc, selectedOutputTurns: int(0), selectedOutputRef: ARTIFACT,
};
const CASE_COMMON: Readonly<Record<string, Check>> = {
  ...BIND, caseId: oneOf(CONTROLLED_FAILURE_CASE_IDS, 64), startUtc: utc, endUtc: utc, clockRef: EVIDENCE_REF,
  topologyRef: EVIDENCE_REF, evidenceRef: ARTIFACT, capability: oneOf(CAPABILITIES, 11),
};
const DELIVERY: Readonly<Record<string, Check>> = {
  ...CASE_COMMON, expectedSegments: int(1), ackedSegments: int(0), turnOutcome: oneOf(["done", "failed", "unconfirmed"], 11),
  answerSubstituted: bool, automaticResends: int(0), historyDigest: DIGEST, baselineHistoryDigest: DIGEST,
};
const FINAL: Readonly<Record<string, Check>> = {
  ...CASE_COMMON, finalDelivered: bool, baselineFinalDelivered: bool, finalDigest: DIGEST, baselineFinalDigest: DIGEST,
  historyDigest: DIGEST, baselineHistoryDigest: DIGEST,
};
const CASE_SPECS: Readonly<Record<ControlledFailureCaseId, Readonly<Record<string, Check>>>> = {
  partial_segment_delivery_failure: DELIVERY,
  all_segment_delivery_failure: DELIVERY,
  missing_message_identity: DELIVERY,
  host_network_card_api_outage_restored: { ...FINAL, faultRef: EVIDENCE_REF },
  progress_card_send_edit_failure: { ...FINAL, progressEnabled: bool, genericStatusCount: int(0) },
  card_write_http_429_cooldown: FINAL,
};
const FINDING: Readonly<Record<string, Check>> = {
  ...BIND, code: oneOf(["output_parity_mismatch", "card_lost_final"], 22), capability: oneOf(CAPABILITIES, 11), atUtc: utc,
  evidenceRef: ARTIFACT,
};

// ─── Assessment ─────────────────────────────────────────────────────────────

class Sink {
  private readonly list: Diag[] = [];
  private readonly seen = new Set<string>();
  readonly reasons = new Set<EvalReason>();
  add(path: string, rule: SelectedOutputRule): void {
    this.reasons.add((BATCH_REASON_RULES.has(rule) ? rule : "missing_evidence") as EvalReason);
    const key = `${path}\0${rule}`;
    if (this.seen.has(key) || this.list.length >= MAX_DIAGNOSTICS) return;
    this.seen.add(key);
    this.list.push(Object.freeze({ path, rule }));
  }
  diagnostics(): readonly Diag[] { return Object.freeze([...this.list]); }
}

/** Closed record check; returns the parsed object only when every field is valid. */
function checkRecord(raw: unknown, spec: Readonly<Record<string, Check>>, at: string, sink: Sink): JsonObject | null {
  let o: JsonObject;
  try {
    o = parseRecordText(raw, 2, 64);
  } catch (err) {
    sink.add(at, err !== null && typeof err === "object" && "rule" in err ? (err as { rule: EvidenceRule }).rule : "malformed_json");
    return null;
  }
  let ok = true;
  for (const key of Object.keys(o)) if (!Object.hasOwn(spec, key)) { sink.add(at, "unknown_field"); ok = false; }
  for (const [key, check] of Object.entries(spec)) {
    if (!Object.hasOwn(o, key)) {
      if (!OPTIONAL.has(key)) { sink.add(`${at}/${key}`, "missing_field"); ok = false; }
      continue;
    }
    const v = o[key];
    const rule = v === null ? "null_value" : check(v);
    if (rule !== null) { sink.add(`${at}/${key}`, rule); ok = false; }
  }
  return ok ? o : null;
}

const P = (iso: unknown): number => Date.parse(iso as string);

/** Binding of one record: declaration, receipt snapshot, candidate binding, environment and (for rows) the header. */
function bound(o: JsonObject, env: SelectedOutputEnvironment, header: JsonObject | null, span: [number, number]): boolean {
  const d = env.declaration;
  const b = env.binding;
  if (!env.receiptGenuine || b === null) return false;
  if (o.batchId !== d.batchId || o.cohortRef !== d.cohortRef || o.cohortRef !== env.cohortRef) return false;
  if (o.livenessBatchId !== env.livenessBatchId) return false;
  if (o.candidateSha !== b.candidateSha || o.candidateSha !== env.deploymentCandidateSha) return false;
  if (o.frozenBaselineSha !== b.frozenBaselineSha) return false;
  const runtime = { codexSdkVersion: o.codexSdkVersion as string, codexCliVersion: o.codexCliVersion as string, nodeVersion: o.nodeVersion as string };
  const envMatch = [...b.environments.values()].some((e) => e.apiOrigin === o.apiOrigin && sameRuntime(e.runtime, runtime)
    && e.profileHash === o.profileHash && e.templateFingerprint === o.templateFingerprint);
  if (!envMatch || !b.sourceRuntimes.some((r) => sameRuntime(r, runtime))) return false;
  if (header !== null && BIND_KEYS.some((k) => o[k] !== header[k])) return false;
  // Collected strictly after the declaration, inside the declared batch [start, end), never after evaluation.
  const [s, e] = span;
  const a = P(d.startUtc);
  const end = P(d.endUtc);
  return s <= e && s >= a && e < end && s > P(d.declaredAtUtc) && e <= env.evalUtc;
}

interface CaseVerdict { readonly matches: boolean; readonly critical: CriticalFindingCode | null }

/** Case predicates against the frozen-baseline oracle (v24 case table); never a self-reported verdict. */
function judge(id: ControlledFailureCaseId, o: JsonObject, env: SelectedOutputEnvironment, span: [number, number]): CaseVerdict {
  const historyEqual = o.historyDigest === o.baselineHistoryDigest;
  if (id === "partial_segment_delivery_failure" || id === "all_segment_delivery_failure" || id === "missing_message_identity") {
    const expected = o.expectedSegments as number;
    const acked = o.ackedSegments as number;
    const outcome = o.turnOutcome as string;
    const substituted = o.answerSubstituted === true;
    const resends = o.automaticResends as number;
    // Card-caused parity: card/status text as the answer, history differing from baseline, or a duplicating resend.
    const parity = substituted || !historyEqual || (id === "missing_message_identity" && resends > 0);
    let matches = !substituted && historyEqual && resends === 0;
    // Cases 1-3 require the accepted >=2-segment controlled fixture; case 1 needs a genuine partial split.
    matches &&= expected >= 2;
    if (id === "partial_segment_delivery_failure") matches &&= outcome === "failed" && acked > 0 && acked < expected;
    if (id === "all_segment_delivery_failure") matches &&= outcome === "failed" && acked === 0;
    if (id === "missing_message_identity") matches &&= (outcome === "failed" || outcome === "unconfirmed") && acked < expected;
    return { matches, critical: parity ? "output_parity_mismatch" : null };
  }
  const delivered = o.finalDelivered === true;
  const baselineDelivered = o.baselineFinalDelivered === true;
  const finalEqual = delivered === baselineDelivered && o.finalDigest === o.baselineFinalDigest && historyEqual;
  // Baseline-equivalent failure is never attributed to cards.
  const critical: CriticalFindingCode | null = baselineDelivered && !delivered ? "card_lost_final"
    : finalEqual ? null : "output_parity_mismatch";
  if (id === "host_network_card_api_outage_restored") return { matches: finalEqual, critical };
  if (id === "progress_card_send_edit_failure") {
    const status = o.genericStatusCount as number;
    const statusOk = o.progressEnabled === true ? status <= 1 : status === 0;
    return { matches: finalEqual && delivered && statusOk, critical };
  }
  // card_write_http_429_cooldown: one merged per-origin cooldown, with a recorded start, inside the case window.
  const seen = env.cooldownObserved(originRefOf(o.apiOrigin as string), span[0], span[1]);
  return { matches: finalEqual && seen.components === 1 && seen.starts >= 1, critical };
}

export interface SelectedOutputRecords {
  readonly header: unknown;
  readonly cases: unknown;
  readonly findings: unknown;
}

/** Validates and judges one M-05 selected-output evidence set; all applicable diagnostics, at most 16. */
export function assessSelectedOutput(records: SelectedOutputRecords, env: SelectedOutputEnvironment): SelectedOutputAssessment {
  const sink = new Sink();
  const criticals: CardCausedCritical[] = [];

  const header = checkRecord(records.header, HEADER, "/header", sink);
  let headerBound = false;
  if (header !== null) {
    headerBound = bound(header, env, null, [P(header.startUtc), P(header.endUtc)]);
    if (!headerBound) sink.add("/header", "binding_mismatch");
    else if ((header.selectedOutputTurns as number) < MIN_SELECTED_OUTPUT_TURNS) sink.add("/header/selectedOutputTurns", "insufficient_samples");
  }
  // Rows are compared with any parsed header; an unparsable header is diagnosed once, not per row.
  const reference = header;

  const cases = Array.isArray(records.cases) ? (records.cases as readonly unknown[]) : null;
  if (cases === null) sink.add("/cases", "wrong_type");
  const present = new Set<string>();
  (cases ?? []).forEach((raw, i) => {
    const at = `/cases/${i}`;
    let parsed: JsonObject;
    try {
      parsed = parseRecordText(raw, 2, 64);
    } catch (err) {
      sink.add(at, err !== null && typeof err === "object" && "rule" in err ? (err as { rule: EvidenceRule }).rule : "malformed_json");
      return;
    }
    const id = parsed.caseId;
    if (typeof id !== "string") { sink.add(`${at}/caseId`, id === undefined ? "missing_field" : "wrong_type"); return; }
    if (!(CONTROLLED_FAILURE_CASE_IDS as readonly string[]).includes(id)) { sink.add(at, "unknown_case_id"); return; }
    const caseId = id as ControlledFailureCaseId;
    const o = checkRecord(raw, CASE_SPECS[caseId], at, sink);
    if (o === null) return;
    if (Object.hasOwn(o, "ackedSegments") && (o.ackedSegments as number) > (o.expectedSegments as number)) {
      sink.add(`${at}/ackedSegments`, "grammar");
      return;
    }
    if (present.has(caseId)) { sink.add(at, "duplicate_case_id"); return; }
    present.add(caseId);
    const span: [number, number] = [P(o.startUtc), P(o.endUtc)];
    if (!bound(o, env, reference, span)) { sink.add(at, "binding_mismatch"); return; }
    const verdict = judge(caseId, o, env, span);
    if (!verdict.matches) sink.add(at, "outcome_mismatch");
    if (verdict.critical !== null) {
      criticals.push(Object.freeze({ code: verdict.critical, capability: o.capability as Capability, atUtc: o.endUtc as string }));
    }
  });
  for (const id of CONTROLLED_FAILURE_CASE_IDS) if (!present.has(id)) sink.add("/cases", "missing_case_id");

  const findings = records.findings === undefined ? [] : Array.isArray(records.findings) ? (records.findings as readonly unknown[]) : null;
  if (findings === null) sink.add("/findings", "wrong_type");
  else {
    findings.forEach((raw, i) => {
      const at = `/findings/${i}`;
      const o = checkRecord(raw, FINDING, at, sink);
      if (o === null) return;
      if (!bound(o, env, reference, [P(o.atUtc), P(o.atUtc)])) { sink.add(at, "binding_mismatch"); return; }
      criticals.push(Object.freeze({ code: o.code as CriticalFindingCode, capability: o.capability as Capability, atUtc: o.atUtc as string }));
    });
  }
  return Object.freeze({
    diagnostics: sink.diagnostics(),
    reasons: Object.freeze([...sink.reasons].sort()),
    criticals: Object.freeze(criticals),
  });
}
