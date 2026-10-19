/**
 * WP-14 closed telemetry boundary (`src/cards/telemetry.ts`).
 *
 * The only public entry to the content-free metric sink, the evidence and
 * batch-input record validators, the pinned acceptance registry and the
 * M-01–M-05 evaluators. Every export is pure: there is no runtime wiring,
 * stream, timer, store, network, configuration or event consumer here, and
 * the evaluators return action signals as data without performing them.
 *
 * Helper modules (`telemetry-*.ts`) are implementation detail; consumers
 * import from this module only. The export list is closed and asserted by
 * tests.
 */

export {
  AUTHENTICATED_DISPOSITIONS, CAPABILITIES, CAPABILITY_STATES, COOLDOWN_CODES, COOLDOWN_END_CODES, CRITICAL_CODES,
  DELIVERY_FAILURE_CODES, DISPOSITION_CODES, EXCLUSION_CODES, INELIGIBLE_CODES, INVALIDATION_CODES, LABEL_KEYS, LEVELS,
  LOSS_CODES, M01_CRITICAL_CODES, M05_CRITICAL_CODES, METRIC_NAMES, METRIC_ROWS, POLICY_FETCH_CODES,
  PROCESS_CLOSE_CODES, RECOVERY_CODES, RETRY_CODES, ROUTE_TYPES, SAFE_REASON_CODES, TELEMETRY_LIMITS,
  TELEMETRY_REJECT_CODES, TOPOLOGIES, WRITE_FAILURES, WRITE_OUTCOMES, dispositionCode, metricRow, seriesCount,
} from "./telemetry-registry.js";
export type {
  Capability, CriticalCode, DispositionCode, DurableDisposition, EmitMetricName, ExclusionCode, IntervalMetricName,
  LabelKey, LabelSpec, LossCode, MetricEntry, MetricLevel, MetricName, MetricRow, MetricType, SeriesCount, SeriesScope,
  TelemetryRejectCode, WriteFailure,
} from "./telemetry-registry.js";

export { botRefOf, channelRefOf, originRefOf, processRefOf } from "./telemetry-grammar.js";

export { METRIC_LINE_PREFIX, TelemetryConfigError, createTelemetrySink } from "./telemetry-sink.js";
export type { ClockPolicy, EmitResult, TelemetryHealth, TelemetrySink, TelemetrySinkOptions } from "./telemetry-sink.js";

export {
  EVIDENCE_RULES, MAX_STORE_ORACLE_REFS, RECORD_MAX_BYTES, declarationSetReasons, validateBatchDeclaration,
  validateDeploymentRecord, validateExclusionRecord, validateLivenessRecord,
} from "./telemetry-records.js";
export type {
  BatchDeclaration, BatchMetric, DeploymentRecord, DeploymentSlot, EvidenceRule, ExclusionMetric, ExclusionRecord,
  IncarnationExit, LivenessIncarnation, LivenessProcess, LivenessRecord, RecordResult,
} from "./telemetry-records.js";

export {
  ACCEPTANCE_LEVELS, ACCEPTANCE_REGISTRY_SHA256, ACCEPTANCE_REGISTRY_VERSION, ACCEPTANCE_SUBIDS_V1, ATTESTABLE_LEVELS,
  RECORDABLE_LEVELS, acceptanceRegistryDigest, acceptanceRow,
} from "./telemetry-acceptance.js";
export type { AcceptanceLevel, AcceptancePriority, AcceptanceRow } from "./telemetry-acceptance.js";

export {
  environmentRuntimesCovered, evidenceBindingValid, isSafeText, safeTextRule, validateEvidenceRecord,
  validateSourceAttestation,
} from "./telemetry-evidence.js";
export type {
  AttestableLevel, EnvironmentTuple, EvidenceBinding, EvidenceRecord, EvidenceResult, EvidenceValidation,
  RecordableLevel, RuntimeTuple, SourceAttestation,
} from "./telemetry-evidence.js";

export {
  actionSignalValid, batchSignals, cooldownComponents, evaluateBatch, evaluateM01, inspectEvaluation, intersects, openEvaluation,
  openSelectedOutputEvidence,
  parseCollection, resumeAllowed, revise, windowEvaluation,
} from "./telemetry-evaluator.js";
export type {
  ActionSignal, AdmissionCounts, BatchEvaluation, BatchOptions, BatchStatus, ChainEntry, CooldownWindowStats,
  DrillSignal, EvalReason, EvaluationInput, EvaluationInspection, EvaluationReceipt, LatencyCounts, M01Evaluation,
  M01Input, M01RowResult, MetricLine, OriginCooldown, ParsedCollection, Problem, ProblemKind, RowVerdict, ScoringCheck,
  SelectedOutputEvidence, SelectedOutputInput, SelectedOutputOpening, SignalAction, SignalMetric, SignalReason, SignalScope,
  WindowEvaluation,
} from "./telemetry-evaluator.js";

export { CONTROLLED_FAILURE_CASE_IDS } from "./telemetry-selected-output.js";
export type { ControlledFailureCaseId } from "./telemetry-selected-output.js";
