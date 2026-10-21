/**
 * Pinned acceptance sub-ID registry `acceptance-subids.v1` (§4.1, PRD v4 §8).
 *
 * 99 rows `{subId, declaredLevel, priority}`; P0 = 94 scored rows, P1 = 5
 * independently gated rows. The SHA-256 of the canonical serialization
 * (`JSON.stringify` of the row objects in this order) is recorded below and
 * re-derived by tests; any edit to a row changes the digest.
 */

import { createHash } from "node:crypto";

export const ACCEPTANCE_LEVELS = ["unit", "integration", "restart_fault", "live_api", "deployment", "black_box"] as const;
export type AcceptanceLevel = (typeof ACCEPTANCE_LEVELS)[number];
/** Levels carried by `EvidenceRecord` (A6). */
export const RECORDABLE_LEVELS = ["live_api", "deployment", "black_box"] as const;
/** Levels carried by `SourceAttestation` (O-10 A). */
export const ATTESTABLE_LEVELS = ["unit", "integration", "restart_fault"] as const;
export type AcceptancePriority = "P0" | "P1";

export interface AcceptanceRow {
  readonly subId: string;
  readonly declaredLevel: AcceptanceLevel;
  readonly priority: AcceptancePriority;
}

export const ACCEPTANCE_REGISTRY_VERSION = "acceptance-subids.v1";
export const ACCEPTANCE_REGISTRY_SHA256 = "3a41df240a2a440a78a334d0633b4dff3d5f45c4b281b23b549a84df07e2dc38";

const RAW: readonly (readonly [string, AcceptanceLevel, AcceptancePriority])[] = [
  ["AC-001.1", "unit", "P0"],
  ["AC-001.2", "unit", "P0"],
  ["AC-002.1", "integration", "P0"],
  ["AC-002.2", "integration", "P0"],
  ["AC-003.1", "integration", "P0"],
  ["AC-003.2", "live_api", "P0"],
  ["AC-004.1", "unit", "P0"],
  ["AC-004.2", "live_api", "P0"],
  ["AC-005.1", "unit", "P0"],
  ["AC-005.2", "integration", "P0"],
  ["AC-005.3", "integration", "P0"],
  ["AC-006.1", "unit", "P0"],
  ["AC-006.2", "unit", "P1"],
  ["AC-006.3", "integration", "P1"],
  ["AC-007.1", "integration", "P0"],
  ["AC-007.2", "integration", "P0"],
  ["AC-007.3", "integration", "P0"],
  ["AC-007.4", "unit", "P0"],
  ["AC-007.5", "integration", "P0"],
  ["AC-007.6", "integration", "P0"],
  ["AC-008.1", "unit", "P0"],
  ["AC-008.2", "integration", "P0"],
  ["AC-008.3", "integration", "P0"],
  ["AC-008.4", "integration", "P0"],
  ["AC-008.5", "integration", "P0"],
  ["AC-009.1", "integration", "P0"],
  ["AC-009.2", "integration", "P0"],
  ["AC-010.1", "unit", "P0"],
  ["AC-010.2", "unit", "P0"],
  ["AC-010.3", "unit", "P0"],
  ["AC-010.4", "integration", "P0"],
  ["AC-011.1", "unit", "P0"],
  ["AC-011.2", "integration", "P0"],
  ["AC-011.3", "integration", "P0"],
  ["AC-011.4", "integration", "P0"],
  ["AC-011.5", "integration", "P0"],
  ["AC-011.6", "integration", "P0"],
  ["AC-011.7", "integration", "P0"],
  ["AC-011.8", "integration", "P0"],
  ["AC-011.9", "integration", "P0"],
  ["AC-011.10", "integration", "P0"],
  ["AC-011.11", "integration", "P0"],
  ["AC-012.1", "unit", "P0"],
  ["AC-012.2", "unit", "P0"],
  ["AC-012.3", "integration", "P0"],
  ["AC-012.4", "integration", "P0"],
  ["AC-012.5", "integration", "P0"],
  ["AC-013.1", "integration", "P0"],
  ["AC-013.2", "integration", "P0"],
  ["AC-013.3", "integration", "P0"],
  ["AC-013.4", "live_api", "P0"],
  ["AC-014.1", "unit", "P0"],
  ["AC-014.2", "unit", "P0"],
  ["AC-014.3", "integration", "P0"],
  ["AC-014.4", "integration", "P0"],
  ["AC-015.1", "integration", "P0"],
  ["AC-015.2", "integration", "P0"],
  ["AC-015.3", "integration", "P0"],
  ["AC-016.1", "integration", "P0"],
  ["AC-016.2", "integration", "P0"],
  ["AC-016.3", "integration", "P0"],
  ["AC-016.4", "integration", "P0"],
  ["AC-017.1", "restart_fault", "P0"],
  ["AC-017.2", "restart_fault", "P0"],
  ["AC-018.1", "integration", "P0"],
  ["AC-018.2", "integration", "P0"],
  ["AC-018.3", "integration", "P1"],
  ["AC-018.4", "restart_fault", "P1"],
  ["AC-018.5", "unit", "P0"],
  ["AC-019.1", "unit", "P0"],
  ["AC-019.2", "integration", "P0"],
  ["AC-019.3", "unit", "P1"],
  ["AC-020.1", "integration", "P0"],
  ["AC-020.2", "black_box", "P0"],
  ["AC-021.1", "integration", "P0"],
  ["AC-021.2", "black_box", "P0"],
  ["AC-022.1", "deployment", "P0"],
  ["AC-022.2", "deployment", "P0"],
  ["AC-022.3", "deployment", "P0"],
  ["AC-022.4", "deployment", "P0"],
  ["AC-022.5", "deployment", "P0"],
  ["AC-023.1", "live_api", "P0"],
  ["AC-023.2", "live_api", "P0"],
  ["AC-023.3", "live_api", "P0"],
  ["AC-023.4", "live_api", "P0"],
  ["AC-023.5", "live_api", "P0"],
  ["AC-023.6", "live_api", "P0"],
  ["AC-023.7", "live_api", "P0"],
  ["AC-023.8", "live_api", "P0"],
  ["AC-023.9", "live_api", "P0"],
  ["AC-023.10", "live_api", "P0"],
  ["AC-024.1", "black_box", "P0"],
  ["AC-024.2", "black_box", "P0"],
  ["AC-024.3", "black_box", "P0"],
  ["AC-024.4", "black_box", "P0"],
  ["AC-024.5", "black_box", "P0"],
  ["AC-025.1", "deployment", "P0"],
  ["AC-025.2", "black_box", "P0"],
  ["AC-025.3", "deployment", "P0"],
];

export const ACCEPTANCE_SUBIDS_V1: readonly AcceptanceRow[] = Object.freeze(
  RAW.map(([subId, declaredLevel, priority]) => Object.freeze({ subId, declaredLevel, priority })),
);

const BY_SUB_ID: ReadonlyMap<string, AcceptanceRow> = new Map(ACCEPTANCE_SUBIDS_V1.map((r) => [r.subId, r]));

export function acceptanceRow(subId: unknown): AcceptanceRow | undefined {
  return typeof subId === "string" ? BY_SUB_ID.get(subId) : undefined;
}

/** SHA-256 of the canonical registry serialization. */
export function acceptanceRegistryDigest(rows: readonly AcceptanceRow[] = ACCEPTANCE_SUBIDS_V1): string {
  const canonical = rows.map((r) => ({ subId: r.subId, declaredLevel: r.declaredLevel, priority: r.priority }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function isRecordableLevel(level: AcceptanceLevel): boolean {
  return (RECORDABLE_LEVELS as readonly string[]).includes(level);
}
