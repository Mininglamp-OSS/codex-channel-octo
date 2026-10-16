import { describe, expect, it } from "vitest";
import {
  AUTHENTICATED_DISPOSITIONS, CAPABILITY_STATES, CRITICAL_CODES, DISPOSITION_CODES, LOSS_CODES, M01_CRITICAL_CODES,
  M05_CRITICAL_CODES, METRIC_ROWS, SAFE_REASON_CODES, TELEMETRY_LIMITS, TELEMETRY_REJECT_CODES, WRITE_FAILURES,
  WRITE_OUTCOMES, dispositionCode, metricRow, seriesCount,
} from "../cards/telemetry.js";

describe("closed code enums (§3.3)", () => {
  it("reuses the WP-01 enums exactly", () => {
    expect(SAFE_REASON_CODES).toEqual([
      "profile_404", "profile_unavailable", "profile_malformed", "config_inconsistent", "capability_disabled",
      "auth_rejected", "template_incompatible", "profile_incompatible", "local_disabled", "policy_revoked",
      "interaction_unavailable",
    ]);
    expect(CAPABILITY_STATES).toEqual(["enabled", "disabled", "unavailable"]);
    expect(WRITE_OUTCOMES).toEqual(["acked", "ambiguous", "stale", "contract", "policy", "gone", "retry_exhausted"]);
    expect(WRITE_FAILURES).toEqual(WRITE_OUTCOMES.filter((x) => x !== "acked"));
  });

  it("keeps the proposed closed sets at their registry sizes", () => {
    expect(DISPOSITION_CODES).toHaveLength(11);
    expect(CRITICAL_CODES).toEqual([...M01_CRITICAL_CODES, ...M05_CRITICAL_CODES, "event_stream_halt", "synthetic_drill"]);
    expect(M01_CRITICAL_CODES).toHaveLength(6);
    expect(TELEMETRY_REJECT_CODES).toHaveLength(12);
    expect(LOSS_CODES).toEqual([...TELEMETRY_REJECT_CODES, "sink_failed"]);
  });
});

describe("closed registry (§3.4)", () => {
  it("has rows 1–35 without the retired #28 and unique names", () => {
    expect(METRIC_ROWS.map((r) => r.n)).toEqual([...Array.from({ length: 27 }, (_, i) => i + 1), 29, 30, 31, 32, 33, 34, 35]);
    expect(new Set(METRIC_ROWS.map((r) => r.name)).size).toBe(34);
    expect(Object.isFrozen(METRIC_ROWS)).toBe(true);
    expect(Object.isFrozen(METRIC_ROWS[0])).toBe(true);
  });

  it("marks exactly the loss-bearing M rows", () => {
    expect(METRIC_ROWS.filter((r) => r.lossBearing).map((r) => r.n))
      .toEqual([6, 7, 8, 9, 10, 11, 12, 16, 17, 20, 21, 22, 25, 29, 31, 32, 33, 34, 35]);
  });

  it("fixes level and entry per row", () => {
    expect(metricRow("critical_signal_total")?.level).toBe("critical");
    expect(metricRow("cooldown_slice_ms")?.entry).toBe("interval");
    expect(metricRow("cooldown_mandated_ms")?.entry).toBe("interval");
    for (const n of [30, 32, 33, 35]) expect(METRIC_ROWS.find((r) => r.n === n)?.entry).toBe("internal");
    expect(metricRow("__proto__")).toBeUndefined();
    expect(metricRow("toString")).toBeUndefined();
    expect(metricRow(42)).toBeUndefined();
  });

  it("reproduces the executed cardinality totals for O-8 A and B", () => {
    expect(seriesCount("A")).toEqual({ perBot: 824, perOrigin: 7, perProcess: 27, botless: 360, total: 53_235 });
    expect(seriesCount("B")).toEqual({ perBot: 815, perOrigin: 7, perProcess: 27, botless: 360, total: 52_659 });
  });

  it("pins the numeric limits used by the contract", () => {
    expect(TELEMETRY_LIMITS).toMatchObject({
      counterMax: 1000, durationCeilMs: 86_400_000, sliceRawMaxMs: 61_000, backCoverMs: 122_000,
      mandatedCeilMs: 2_592_000_000, lineCapBytes: 1024, maxBots: 64, maxOrigins: 16, gapMs: 90_000,
      divergenceMs: 5_000, horizonMs: 62_000, maxGraceMs: 600_000, windowMs: 600_000,
    });
  });
});

describe("disposition mapping (§3.3)", () => {
  it("maps steps exactly and never emits a T4 sweeper expiry on #22", () => {
    expect(dispositionCode("unauthorized", 6)).toBe("unauthorized_actor");
    for (const step of [1, 2, 3, 4, 5]) expect(dispositionCode("unauthorized", step)).toBe("unauthorized_binding");
    expect(dispositionCode("unauthorized", 7)).toBeNull();
    expect(dispositionCode("unauthorized")).toBeNull();
    expect(dispositionCode("expired", 9)).toBe("expired");
    expect(dispositionCode("expired")).toBeNull();
    expect(dispositionCode("expired", 4)).toBeNull();
    for (const d of ["admitted", "duplicate", "invalid", "unknown", "poison", "rejected", "dead_letter", "unsupported_control"] as const) {
      expect(dispositionCode(d)).toBe(d);
    }
  });

  it("defines O-8 A/B authenticated sets with unsupported_control excluded", () => {
    expect([...AUTHENTICATED_DISPOSITIONS.A]).toEqual(["admitted", "duplicate", "invalid", "unauthorized_actor", "expired", "rejected", "dead_letter"]);
    expect([...AUTHENTICATED_DISPOSITIONS.B]).toEqual(["admitted", "duplicate", "invalid", "expired", "rejected", "dead_letter"]);
  });
});
