/**
 * Closed WP-14 metric registry, label grammar and enum sets (§3.2–§3.4).
 *
 * Pure data and pure functions only: no I/O, no clocks, no global state.
 * Every name, enum value and limit here is the closed v15 registry; adding a
 * row, label key or code requires a reviewed contract change.
 */

import type { CapabilityState, RouteKind, SafeReasonCode, WriteOutcome } from "./contracts.js";

// ─── Closed code enums (§3.3) ───────────────────────────────────────────────

export const SAFE_REASON_CODES = [
  "profile_404", "profile_unavailable", "profile_malformed", "config_inconsistent", "capability_disabled",
  "auth_rejected", "template_incompatible", "profile_incompatible", "local_disabled", "policy_revoked",
  "interaction_unavailable",
] as const satisfies readonly SafeReasonCode[];

export const CAPABILITY_STATES = ["enabled", "disabled", "unavailable"] as const satisfies readonly CapabilityState[];

export const WRITE_OUTCOMES = [
  "acked", "ambiguous", "stale", "contract", "policy", "gone", "retry_exhausted",
] as const satisfies readonly WriteOutcome[];

export type WriteFailure = Exclude<WriteOutcome, "acked">;
export const WRITE_FAILURES = [
  "ambiguous", "stale", "contract", "policy", "gone", "retry_exhausted",
] as const satisfies readonly WriteFailure[];

export const DISPOSITION_CODES = [
  "admitted", "duplicate", "invalid", "unauthorized_actor", "unauthorized_binding", "unknown", "poison",
  "expired", "rejected", "dead_letter", "unsupported_control",
] as const;
export type DispositionCode = (typeof DISPOSITION_CODES)[number];

export const POLICY_FETCH_CODES = [
  "ok", "profile_404", "profile_unavailable", "profile_malformed", "auth_rejected", "config_inconsistent",
] as const;
export const INVALIDATION_CODES = ["ttl_expired", "bot_setting_updated", "policy_revoked"] as const;
export const INELIGIBLE_CODES = ["unauthorized", "thinking_only", "no_first_frame", "policy_disabled"] as const;
export const EXCLUSION_CODES = ["api_outage", "server_cooldown"] as const;
export type ExclusionCode = (typeof EXCLUSION_CODES)[number];
export const COOLDOWN_CODES = ["client_backoff", "server_retry_after"] as const;
export const COOLDOWN_END_CODES = ["elapsed", "shutdown"] as const;
export const RETRY_CODES = ["retry_1", "retry_2"] as const;
export const RECOVERY_CODES = [
  "interrupted_closed", "send_reconciled", "send_abandoned", "session_expired", "admission_ambiguous",
  "store_quarantined", "halt_preserved",
] as const;
export const DELIVERY_FAILURE_CODES = ["partial", "all_failed", "missing_identity"] as const;

/** M-01 critical set (TD3 F.2). */
export const M01_CRITICAL_CODES = [
  "unauthorized_admission", "duplicate_admission", "cross_bot_route_leak", "protected_token", "corrupt_ownership",
  "stale_terminal_overwrite",
] as const;
/** M-05 critical set. */
export const M05_CRITICAL_CODES = ["output_parity_mismatch", "card_lost_final"] as const;
export const CRITICAL_CODES = [
  ...M01_CRITICAL_CODES, ...M05_CRITICAL_CODES, "event_stream_halt", "synthetic_drill",
] as const;
export type CriticalCode = (typeof CRITICAL_CODES)[number];

export const PROCESS_CLOSE_CODES = ["process_shutdown"] as const;
export const TELEMETRY_REJECT_CODES = [
  "unknown_metric", "unknown_label", "missing_label", "label_not_allowed", "invalid_label_value", "invalid_labels",
  "invalid_value", "invalid_interval", "cardinality_exceeded", "line_too_long", "clock_invalid", "internal_error",
] as const;
export type TelemetryRejectCode = (typeof TELEMETRY_REJECT_CODES)[number];
export const LOSS_CODES = [...TELEMETRY_REJECT_CODES, "sink_failed"] as const;
export type LossCode = (typeof LOSS_CODES)[number];

export const CAPABILITIES = ["automatic", "display", "interaction"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const ROUTE_TYPES = ["dm", "group", "topic"] as const satisfies readonly RouteKind[];
export const TOPOLOGIES = ["t_part", "t_excl"] as const;
export const LEVELS = ["info", "warn", "critical"] as const;
export type MetricLevel = (typeof LEVELS)[number];

// ─── Label grammar (§3.2) ───────────────────────────────────────────────────

export const LABEL_KEYS = ["bot_ref", "origin_ref", "capability", "route_type", "code", "topology", "level"] as const;
export type LabelKey = (typeof LABEL_KEYS)[number];

export const BOT_REF_PATTERN = /^b[0-9a-f]{16}$/;
export const ORIGIN_REF_PATTERN = /^o[0-9a-f]{16}$/;

export type LabelSpec =
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "ref"; readonly pattern: RegExp };

const en = (values: readonly string[]): LabelSpec => Object.freeze({ kind: "enum", values: Object.freeze([...values]) });
const BOT: LabelSpec = Object.freeze({ kind: "ref", pattern: BOT_REF_PATTERN });
const ORG: LabelSpec = Object.freeze({ kind: "ref", pattern: ORIGIN_REF_PATTERN });
const CAP = en(CAPABILITIES);
const RT = en(ROUTE_TYPES);
const TOPO = en(TOPOLOGIES);
const AUTO = en(["automatic"]);
const AUTO_INT = en(["automatic", "interaction"]);

export function labelValueAllowed(spec: LabelSpec, value: unknown): value is string {
  if (typeof value !== "string") return false;
  return spec.kind === "enum" ? spec.values.includes(value) : spec.pattern.test(value);
}

// ─── Closed registry (§3.4) ─────────────────────────────────────────────────

export type MetricType = "counter" | "duration_ms" | "slice" | "mandated" | "losscount" | "heartbeat";
/** `emit` instant rows, `interval` rows (#17/#34), `internal` sink-owned rows. */
export type MetricEntry = "emit" | "interval" | "internal";
export type SeriesScope = "bot" | "origin" | "process";

export const METRIC_NAMES = [
  "capability_state_total", "capability_reason_total", "policy_fetch_total", "policy_refresh_total",
  "policy_invalidation_total", "first_frame_ms", "first_frame_unacked_total", "first_frame_ineligible_total",
  "first_frame_excluded_total", "terminal_ms", "terminal_unacked_total", "terminal_excluded_total", "card_send_total",
  "card_edit_total", "stale_sequence_total", "cooldown_start_total", "cooldown_slice_ms", "card_degraded_total",
  "card_abandoned_total", "unreconciled_send_aged_total", "closure_edit_failed_total", "action_disposition_total",
  "action_retry_total", "session_expired_total", "unresolved_claim_aged_total", "recovery_action_total",
  "delivery_report_failure_total", "critical_signal_total", "telemetry_rejected_total", "cooldown_end_total",
  "telemetry_loss_total", "telemetry_close_total", "cooldown_mandated_ms", "telemetry_heartbeat_total",
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export interface MetricRow {
  /** Registry row number; #28 is retired and never present. */
  readonly n: number;
  readonly name: MetricName;
  readonly type: MetricType;
  readonly level: MetricLevel;
  readonly required: Readonly<Partial<Record<LabelKey, LabelSpec>>>;
  readonly optional: Readonly<Partial<Record<LabelKey, LabelSpec>>>;
  readonly entry: MetricEntry;
  /** "M": a loss-bearing row whose rejection is recorded as telemetry loss. */
  readonly lossBearing: boolean;
  readonly scope: SeriesScope;
}

type Specs = Partial<Record<LabelKey, LabelSpec>>;
const row = (
  n: number, name: MetricName, type: MetricType, level: MetricLevel, required: Specs, optional: Specs,
  entry: MetricEntry, lossBearing: boolean, scope: SeriesScope,
): MetricRow => Object.freeze({
  n, name, type, level, required: Object.freeze({ ...required }), optional: Object.freeze({ ...optional }), entry,
  lossBearing, scope,
});

const WF = en(WRITE_FAILURES);

export const METRIC_ROWS: readonly MetricRow[] = Object.freeze([
  row(1, "capability_state_total", "counter", "info", { bot_ref: BOT, capability: CAP, code: en(CAPABILITY_STATES) }, {}, "emit", false, "bot"),
  row(2, "capability_reason_total", "counter", "info", { bot_ref: BOT, capability: CAP, code: en(SAFE_REASON_CODES) }, {}, "emit", false, "bot"),
  row(3, "policy_fetch_total", "counter", "info", { bot_ref: BOT, code: en(POLICY_FETCH_CODES) }, {}, "emit", false, "bot"),
  row(4, "policy_refresh_total", "counter", "info", { bot_ref: BOT, code: en(POLICY_FETCH_CODES) }, {}, "emit", false, "bot"),
  row(5, "policy_invalidation_total", "counter", "info", { bot_ref: BOT, code: en(INVALIDATION_CODES) }, {}, "emit", false, "bot"),
  row(6, "first_frame_ms", "duration_ms", "info", { bot_ref: BOT, origin_ref: ORG, route_type: RT, capability: AUTO }, {}, "emit", true, "bot"),
  row(7, "first_frame_unacked_total", "counter", "warn", { bot_ref: BOT, origin_ref: ORG, route_type: RT, capability: AUTO, code: WF }, {}, "emit", true, "bot"),
  row(8, "first_frame_ineligible_total", "counter", "info", { bot_ref: BOT, route_type: RT, code: en(INELIGIBLE_CODES) }, {}, "emit", true, "bot"),
  row(9, "first_frame_excluded_total", "counter", "warn", { bot_ref: BOT, origin_ref: ORG, route_type: RT, code: en(EXCLUSION_CODES) }, {}, "emit", true, "bot"),
  row(10, "terminal_ms", "duration_ms", "info", { bot_ref: BOT, origin_ref: ORG, route_type: RT, capability: AUTO_INT }, {}, "emit", true, "bot"),
  row(11, "terminal_unacked_total", "counter", "warn", { bot_ref: BOT, origin_ref: ORG, route_type: RT, capability: AUTO_INT, code: WF }, {}, "emit", true, "bot"),
  row(12, "terminal_excluded_total", "counter", "warn", { bot_ref: BOT, origin_ref: ORG, route_type: RT, capability: AUTO_INT, code: en(EXCLUSION_CODES) }, {}, "emit", true, "bot"),
  row(13, "card_send_total", "counter", "info", { bot_ref: BOT, origin_ref: ORG, capability: CAP, code: en(WRITE_OUTCOMES) }, {}, "emit", false, "bot"),
  row(14, "card_edit_total", "counter", "info", { bot_ref: BOT, origin_ref: ORG, capability: CAP, code: en(WRITE_OUTCOMES) }, {}, "emit", false, "bot"),
  row(15, "stale_sequence_total", "counter", "warn", { bot_ref: BOT, capability: CAP }, {}, "emit", false, "bot"),
  row(16, "cooldown_start_total", "counter", "warn", { origin_ref: ORG, code: en(COOLDOWN_CODES) }, {}, "emit", true, "origin"),
  row(17, "cooldown_slice_ms", "slice", "warn", { origin_ref: ORG, code: en(COOLDOWN_CODES) }, {}, "interval", true, "origin"),
  row(18, "card_degraded_total", "counter", "warn", { bot_ref: BOT, capability: CAP, route_type: RT, code: en(SAFE_REASON_CODES) }, {}, "emit", false, "bot"),
  row(19, "card_abandoned_total", "counter", "warn", { bot_ref: BOT, capability: CAP, code: WF }, {}, "emit", false, "bot"),
  row(20, "unreconciled_send_aged_total", "counter", "warn", { bot_ref: BOT, capability: CAP }, {}, "emit", true, "bot"),
  row(21, "closure_edit_failed_total", "counter", "warn", { bot_ref: BOT, capability: AUTO_INT, code: WF }, {}, "emit", true, "bot"),
  row(22, "action_disposition_total", "counter", "info", { bot_ref: BOT, route_type: RT, code: en(DISPOSITION_CODES) }, { topology: TOPO }, "emit", true, "bot"),
  row(23, "action_retry_total", "counter", "warn", { bot_ref: BOT, route_type: RT, code: en(RETRY_CODES) }, {}, "emit", false, "bot"),
  row(24, "session_expired_total", "counter", "info", { bot_ref: BOT }, {}, "emit", false, "bot"),
  row(25, "unresolved_claim_aged_total", "counter", "warn", { bot_ref: BOT }, {}, "emit", true, "bot"),
  row(26, "recovery_action_total", "counter", "info", { bot_ref: BOT, capability: CAP, code: en(RECOVERY_CODES) }, {}, "emit", false, "bot"),
  row(27, "delivery_report_failure_total", "counter", "warn", { bot_ref: BOT, route_type: RT, code: en(DELIVERY_FAILURE_CODES) }, {}, "emit", false, "bot"),
  row(29, "critical_signal_total", "counter", "critical", { capability: CAP, code: en(CRITICAL_CODES) }, { bot_ref: BOT, route_type: RT, topology: TOPO }, "emit", true, "bot"),
  row(30, "telemetry_rejected_total", "counter", "warn", { code: en(TELEMETRY_REJECT_CODES) }, {}, "internal", false, "process"),
  row(31, "cooldown_end_total", "counter", "warn", { origin_ref: ORG, code: en(COOLDOWN_END_CODES) }, {}, "emit", true, "origin"),
  row(32, "telemetry_loss_total", "losscount", "warn", { code: en(LOSS_CODES) }, {}, "internal", true, "process"),
  row(33, "telemetry_close_total", "counter", "info", { code: en(PROCESS_CLOSE_CODES) }, {}, "internal", true, "process"),
  row(34, "cooldown_mandated_ms", "mandated", "warn", { origin_ref: ORG, code: en(["server_retry_after"]) }, {}, "interval", true, "origin"),
  row(35, "telemetry_heartbeat_total", "heartbeat", "info", {}, {}, "internal", true, "process"),
]);

const ROW_BY_NAME: ReadonlyMap<string, MetricRow> = new Map(METRIC_ROWS.map((r) => [r.name, r]));

/** Registry lookup; never consults the prototype chain. */
export function metricRow(name: unknown): MetricRow | undefined {
  return typeof name === "string" ? ROW_BY_NAME.get(name) : undefined;
}

export type EmitMetricName = {
  [K in MetricName]: K extends "cooldown_slice_ms" | "cooldown_mandated_ms" | "telemetry_rejected_total"
    | "telemetry_loss_total" | "telemetry_close_total" | "telemetry_heartbeat_total" ? never : K
}[MetricName];
export type IntervalMetricName = "cooldown_slice_ms" | "cooldown_mandated_ms";

// ─── Limits (§3.1, §3.4, §3.6, §3.8, §5.3) ──────────────────────────────────

export const TELEMETRY_LIMITS = Object.freeze({
  counterMax: 1000,
  durationCeilMs: 86_400_000,
  sliceRawMaxMs: 61_000,
  /** R: back-coverage bound of an in-contract #17 call. */
  backCoverMs: 122_000,
  /** C: represented future horizon of #34 and of the M-05 uncertainty tail. */
  mandatedCeilMs: 2_592_000_000,
  mandatedStartSkewMs: 1_000,
  lineCapBytes: 1024,
  monoMax: 1e12,
  utcMax: 253_402_300_799_999,
  maxLabelKeys: 6,
  maxBots: 64,
  maxOrigins: 16,
  heartbeatCadenceMs: 60_000,
  gapMs: 90_000,
  divergenceMs: 5_000,
  horizonMs: 62_000,
  maxGraceMs: 600_000,
  windowMs: 600_000,
  anchorToleranceMs: 1.01,
});

// ─── Cardinality (§3.4) ─────────────────────────────────────────────────────

export interface SeriesCount {
  readonly perBot: number;
  readonly perOrigin: number;
  readonly perProcess: number;
  readonly botless: number;
  readonly total: number;
}

/** Executed cardinality procedure for O-8 A (11 disposition codes) or B (10 durable codes). */
export function seriesCount(o8: "A" | "B" = "A"): SeriesCount {
  const size = (spec: LabelSpec, key: LabelKey, n: number): number => {
    if (spec.kind === "ref") return 1;
    if (o8 === "B" && n === 22 && key === "code") return 10;
    return spec.values.length;
  };
  let perBot = 0;
  let perOrigin = 0;
  let perProcess = 0;
  let botless = 0;
  for (const r of METRIC_ROWS) {
    let count = 1;
    for (const [key, spec] of Object.entries(r.required) as [LabelKey, LabelSpec][]) count *= size(spec, key, r.n);
    const optional = Object.entries(r.optional) as [LabelKey, LabelSpec][];
    if (r.n === 29) {
      for (const [key, spec] of optional) if (key !== "bot_ref") count *= size(spec, key, r.n) + 1;
      perBot += count;
      botless += count;
      continue;
    }
    for (const [key, spec] of optional) count *= size(spec, key, r.n) + 1;
    if (r.scope === "bot") perBot += count;
    else if (r.scope === "origin") perOrigin += count;
    else perProcess += count;
  }
  const { maxBots, maxOrigins } = TELEMETRY_LIMITS;
  return Object.freeze({
    perBot, perOrigin, perProcess, botless, total: maxBots * perBot + botless + maxOrigins * perOrigin + perProcess,
  });
}

// ─── Disposition mapping (§3.3, O-8) ────────────────────────────────────────

export type DurableDisposition =
  | "admitted" | "duplicate" | "invalid" | "unauthorized" | "unknown" | "poison" | "expired" | "rejected"
  | "dead_letter" | "unsupported_control";

/**
 * Emitter-side mapping of a durable disposition to its #22 code. Returns
 * `null` when the disposition is not emitted on #22: a T4 sweeper expiry
 * (any step other than 9, emitted on #24 only) or an `unauthorized`
 * disposition without a pre-admission step in 1–6.
 */
export function dispositionCode(durable: DurableDisposition, step?: number): DispositionCode | null {
  switch (durable) {
    case "unauthorized":
      if (step === 6) return "unauthorized_actor";
      return Number.isSafeInteger(step) && (step as number) >= 1 && (step as number) <= 5 ? "unauthorized_binding" : null;
    case "expired":
      return step === 9 ? "expired" : null;
    case "admitted": case "duplicate": case "invalid": case "unknown": case "poison": case "rejected":
    case "dead_letter": case "unsupported_control":
      return durable;
    default:
      return null;
  }
}

/** M-04 "authenticated" submissions under O-8 A / B; `admitted` is the accepted subset. */
export const AUTHENTICATED_DISPOSITIONS: Readonly<Record<"A" | "B", readonly DispositionCode[]>> = Object.freeze({
  A: Object.freeze(["admitted", "duplicate", "invalid", "unauthorized_actor", "expired", "rejected", "dead_letter"] as const),
  B: Object.freeze(["admitted", "duplicate", "invalid", "expired", "rejected", "dead_letter"] as const),
});
