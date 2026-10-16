/**
 * Synthetic M-05 selected-output evidence records for tests only (never shipped). Digests are fixed
 * synthetic hex values; no content, payload or URL beyond the canonical API origin is ever present.
 */

import { BASE_SHA, COH, ORIGIN, PROFILE, RT, SHA, iso } from "./telemetry-harness.js";

export const CASE_IDS = [
  "partial_segment_delivery_failure", "all_segment_delivery_failure", "missing_message_identity",
  "host_network_card_api_outage_restored", "progress_card_send_edit_failure", "card_write_http_429_cooldown",
] as const;
export type CaseId = (typeof CASE_IDS)[number];

export const HIST = "1".repeat(64);
export const FINAL = "2".repeat(64);
export const OTHER = "3".repeat(64);
const ref = (name: string, hex: string) => `artifact:${name}@sha256:${hex.repeat(64)}`;
export const SELECTED_REF = ref("selected-output", "a");
export const CASE_REF = ref("m05-case", "b");
export const CLOCK_REF = ref("m05-clock", "c");
export const TOPOLOGY_REF = ref("m05-topology", "d");
export const FAULT_REF = ref("m05-outage", "e");
export const FINDING_REF = ref("m05-finding", "f");

type Fields = Record<string, unknown>;
/** Applies overrides; an `undefined` override removes the field. */
const apply = (base: Fields, over: Fields): string => {
  const out: Fields = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return JSON.stringify(out);
};

export const bindFields = (): Fields => ({
  batchId: "m", cohortRef: COH, livenessBatchId: "b1", candidateSha: SHA, frozenBaselineSha: BASE_SHA, ...RT,
  apiOrigin: ORIGIN, profileHash: PROFILE, fixtureRevision: "m05-cases@v1", harnessIdentity: "m05-harness@1.0.0",
});

export const headerRecord = (over: Fields = {}): string => apply({
  ...bindFields(), startUtc: iso(10_000), endUtc: iso(590_000), selectedOutputTurns: 30, selectedOutputRef: SELECTED_REF,
}, over);

const CASE_WINDOWS: Record<CaseId, [number, number]> = {
  partial_segment_delivery_failure: [20_000, 80_000],
  all_segment_delivery_failure: [100_000, 160_000],
  missing_message_identity: [180_000, 240_000],
  host_network_card_api_outage_restored: [260_000, 330_000],
  progress_card_send_edit_failure: [350_000, 410_000],
  card_write_http_429_cooldown: [90_000, 300_000],
};

const observation = (id: CaseId): Fields => {
  const history = { historyDigest: HIST, baselineHistoryDigest: HIST };
  const final = { finalDelivered: true, baselineFinalDelivered: true, finalDigest: FINAL, baselineFinalDigest: FINAL, ...history };
  switch (id) {
    case "partial_segment_delivery_failure":
      return { expectedSegments: 3, ackedSegments: 1, turnOutcome: "failed", answerSubstituted: false, automaticResends: 0, ...history };
    case "all_segment_delivery_failure":
      return { expectedSegments: 3, ackedSegments: 0, turnOutcome: "failed", answerSubstituted: false, automaticResends: 0, ...history };
    case "missing_message_identity":
      return { expectedSegments: 3, ackedSegments: 2, turnOutcome: "unconfirmed", answerSubstituted: false, automaticResends: 0, ...history };
    case "host_network_card_api_outage_restored":
      return { ...final, faultRef: FAULT_REF };
    case "progress_card_send_edit_failure":
      return { ...final, progressEnabled: true, genericStatusCount: 1 };
    case "card_write_http_429_cooldown":
      return final;
  }
};

export const caseRecord = (id: CaseId, over: Fields = {}): string => apply({
  ...bindFields(), caseId: id, startUtc: iso(CASE_WINDOWS[id][0]), endUtc: iso(CASE_WINDOWS[id][1]),
  clockRef: CLOCK_REF, topologyRef: TOPOLOGY_REF, evidenceRef: CASE_REF, capability: "automatic", ...observation(id),
}, over);

export const allCases = (over: Partial<Record<CaseId, Fields>> = {}): string[] => CASE_IDS.map((id) => caseRecord(id, over[id] ?? {}));

export const findingRecord = (over: Fields = {}): string => apply({
  ...bindFields(), code: "card_lost_final", capability: "display", atUtc: iso(400_000), evidenceRef: FINDING_REF,
}, over);
