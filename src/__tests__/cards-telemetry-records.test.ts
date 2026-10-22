import { describe, expect, it } from "vitest";
import {
  declarationSetReasons, validateBatchDeclaration, validateDeploymentRecord, validateExclusionRecord,
  validateLivenessRecord,
} from "../cards/telemetry.js";
import { ART, COH, O, SHA, dep, iso, pr, rec } from "./fixtures/telemetry-harness.js";

const ruleOf = (r: { ok: boolean; rule?: string }): string | undefined => (r.ok ? undefined : r.rule);
const DEP = dep({ s1: [0], s2: [1000, 5000] });

describe("raw encoding rules (§4.2)", () => {
  it("checks raw size before parsing and never parses an oversized record", () => {
    expect(ruleOf(validateDeploymentRecord("{" + " ".repeat(5000)))).toBe("record_too_large");
    expect(ruleOf(validateDeploymentRecord(JSON.stringify(DEP).replace("{", "{" + " ".repeat(4096))))).toBe("record_too_large");
    expect(ruleOf(validateDeploymentRecord(42))).toBe("wrong_type");
    expect(ruleOf(validateDeploymentRecord("[]"))).toBe("wrong_type");
    expect(ruleOf(validateDeploymentRecord('{"a":1,"a":2}'))).toBe("malformed_json");
    expect(ruleOf(validateDeploymentRecord('{"__proto__":{}}'))).toBe("malformed_json");
    expect(ruleOf(validateDeploymentRecord('{"x":[[[[[1]]]]]}'))).toBe("depth_exceeded");
    expect(ruleOf(validateExclusionRecord('{"durationMs":9007199254740993}'))).toBe("malformed_json");
  });
});

describe("DeploymentRecord", () => {
  it("accepts a valid record and returns a frozen copy of known fields only", () => {
    const r = validateDeploymentRecord(JSON.stringify(DEP));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(DEP);
      expect(Object.isFrozen(r.value.processes[0])).toBe(true);
    }
  });

  it("enforces derived processRefs, unique slots and closed keys", () => {
    const mismatch = { ...DEP, processes: [{ ...DEP.processes[0], processRef: pr("other") }] };
    expect(ruleOf(validateDeploymentRecord(JSON.stringify(mismatch)))).toBe("process_ref_mismatch");
    const dup = { ...DEP, processes: [DEP.processes[0], DEP.processes[0]] };
    expect(ruleOf(validateDeploymentRecord(JSON.stringify(dup)))).toBe("slot_duplicate");
    expect(ruleOf(validateDeploymentRecord(JSON.stringify({ ...DEP, extra: 1 })))).toBe("unknown_field");
    const missing: Record<string, unknown> = { ...DEP };
    delete missing.sourceRef;
    expect(ruleOf(validateDeploymentRecord(JSON.stringify(missing)))).toBe("missing_field");
    expect(ruleOf(validateDeploymentRecord(JSON.stringify({ ...DEP, candidateSha: "A".repeat(40) })))).toBe("grammar");
    expect(ruleOf(validateDeploymentRecord(JSON.stringify({ ...DEP, firstIncarnationStartUtc: "2026-10-15T08:00:00Z" })))).toBe("grammar");
    expect(ruleOf(validateDeploymentRecord(JSON.stringify({ ...DEP, processes: [] })))).toBe("wrong_type");
    const badStop = { ...DEP, processes: [{ ...DEP.processes[0], stoppedUtc: "2026-02-30T00:00:00.000Z" }] };
    expect(ruleOf(validateDeploymentRecord(JSON.stringify(badStop)))).toBe("grammar");
    expect(ruleOf(validateDeploymentRecord(JSON.stringify({ ...DEP, cohortRef: null })))).toBe("null_value");
  });

  it("reproduces the NB-6 single-record capacity (41 → 29, 37 → 26)", () => {
    const mk = (n: number, len: number, stop: boolean) => ({
      cohortRef: COH, candidateSha: SHA, firstIncarnationStartUtc: iso(0), sourceRef: ART,
      processes: Array.from({ length: n }, (_, k) => {
        const slot = "s" + k.toString().padStart(len - 1, "0");
        return { processRef: pr(slot), slot, firstStartUtc: iso(0), ...(stop ? { stoppedUtc: iso(1000) } : {}) };
      }),
    });
    const maxOf = (len: number, stop: boolean): [number, string | undefined] => {
      for (let n = 1; n <= 200; n++) {
        const r = validateDeploymentRecord(JSON.stringify(mk(n, len, stop)));
        if (!r.ok) return [n - 1, r.rule];
      }
      return [200, undefined];
    };
    expect(maxOf(4, false)).toEqual([41, "record_too_large"]);
    expect(maxOf(4, true)).toEqual([29, "record_too_large"]);
    expect(maxOf(16, false)).toEqual([37, "record_too_large"]);
    expect(maxOf(16, true)).toEqual([26, "record_too_large"]);
  });
});

describe("LivenessRecord", () => {
  const inc = (k: number) => "i" + k.toString(16).padStart(16, "0");
  const live = (incs: Record<string, unknown>[]) => rec("s1", incs as never);
  const v = (x: unknown, d?: unknown) => ruleOf(validateLivenessRecord(JSON.stringify(x), d as never));

  it("enforces the cross-field rules", () => {
    expect(v(live([{ inc: inc(1), startUtc: iso(0), endUtc: iso(5), exit: "clean", ordinal: 1 }]))).toBeUndefined();
    expect(v(live([{ startUtc: iso(0), endUtc: iso(5), exit: "running" }]))).toBe("running_end_mismatch");
    expect(v(live([{ startUtc: iso(0), exit: "clean" }]))).toBe("running_end_mismatch");
    expect(v(live([{ startUtc: iso(5), endUtc: iso(0), exit: "clean" }]))).toBe("time_order");
    expect(v(live([{ startUtc: iso(0), endUtc: iso(10), exit: "clean" }, { startUtc: iso(5), endUtc: iso(20), exit: "clean" }]))).toBe("incarnation_overlap");
    expect(v(live([{ inc: inc(1), startUtc: iso(0), endUtc: iso(1), exit: "clean" }, { inc: inc(1), startUtc: iso(2), endUtc: iso(3), exit: "clean" }]))).toBe("inc_duplicate");
    expect(v(live([{ startUtc: iso(0), exit: "running", ordinal: 0 }]))).toBe("grammar");
    expect(v(live([{ startUtc: iso(0), exit: "running", ordinal: 1.5 }]))).toBe("grammar");
    expect(v(live([{ startUtc: iso(0), exit: "running", clockPolicy: "B" }]))).toBe("grammar");
    expect(v(live([{ startUtc: iso(0), exit: "crashed", endUtc: iso(1) }]))).toBe("grammar");
    expect(v(live([]))).toBe("wrong_type");
    expect(v(live([7 as never]))).toBe("wrong_type");
    expect(v(live([{ startUtc: iso(0), exit: "running" }]), validateDeploymentRecord(JSON.stringify(dep({ s9: [0] }))).ok
      ? (validateDeploymentRecord(JSON.stringify(dep({ s9: [0] }))) as { value: unknown }).value : undefined)).toBe("process_ref_unknown");
  });

  it("fits 29 incarnations with inc and ordinal in one record and fails closed at 30 (NB-4)", () => {
    const many = (n: number) => live(Array.from({ length: n }, (_, k) => ({
      inc: inc(k + 1), startUtc: iso(k * 10_000), endUtc: iso(k * 10_000 + 5000), exit: "unclean", ordinal: k + 1,
    })));
    expect(v(many(29))).toBeUndefined();
    expect(v(many(30))).toBe("record_too_large");
  });
});

describe("ExclusionRecord", () => {
  const ex = { metric: "M-02", batchId: "m", code: "api_outage", originRef: O, startUtc: iso(0), endUtc: iso(1000), durationMs: 1000, excludedCount: 2, measurementRef: ART };
  it("requires durationMs = end − start within [1, 30 d]", () => {
    expect(validateExclusionRecord(JSON.stringify(ex)).ok).toBe(true);
    expect(ruleOf(validateExclusionRecord(JSON.stringify({ ...ex, durationMs: 999 })))).toBe("exclusion_unrecorded");
    expect(ruleOf(validateExclusionRecord(JSON.stringify({ ...ex, endUtc: iso(0), durationMs: 0 })))).toBe("exclusion_unrecorded");
    expect(ruleOf(validateExclusionRecord(JSON.stringify({ ...ex, durationMs: 2_592_000_001 })))).toBe("grammar");
    expect(ruleOf(validateExclusionRecord(JSON.stringify({ ...ex, excludedCount: 0 })))).toBe("wrong_type");
    expect(ruleOf(validateExclusionRecord(JSON.stringify({ ...ex, metric: "M-04" })))).toBe("grammar");
    expect(ruleOf(validateExclusionRecord(JSON.stringify({ ...ex, code: "privacy" })))).toBe("grammar");
  });

  it("accepts the 447 B worst case", () => {
    const worst = { ...ex, metric: "M-03", batchId: "a".repeat(64), code: "server_cooldown", startUtc: iso(0), endUtc: iso(2_592_000_000),
      durationMs: 2_592_000_000, excludedCount: 1_000_000_000_000_000, measurementRef: "artifact:" + "a".repeat(64) + "@sha256:" + "f".repeat(64) };
    expect(Buffer.byteLength(JSON.stringify(worst))).toBe(447);
    expect(validateExclusionRecord(JSON.stringify(worst)).ok).toBe(true);
  });
});

describe("BatchDeclaration", () => {
  const d = { batchId: "m", cohortRef: COH, metric: "M-04", sequence: 1, startUtc: iso(600_000), endUtc: iso(1_200_000), declaredAtUtc: iso(0) };
  const val = (x: unknown) => validateBatchDeclaration(JSON.stringify(x));
  it("validates the closed fields and O-13 refs", () => {
    expect(val(d).ok).toBe(true);
    expect(ruleOf(val({ ...d, sequence: 0 }))).toBe("grammar");
    expect(ruleOf(val({ ...d, sequence: "1" }))).toBe("wrong_type");
    expect(ruleOf(val({ ...d, endUtc: d.startUtc }))).toBe("time_order");
    expect(ruleOf(val({ ...d, metric: "M-02", storeOracleRefs: [ART] }))).toBe("grammar");
    expect(ruleOf(val({ ...d, storeOracleRefs: Array(17).fill(ART) }))).toBe("too_long");
    expect(ruleOf(val({ ...d, storeOracleRefs: ["comment:XIN-1#00000000-0000-0000-0000-000000000000"] }))).toBe("grammar");
  });

  it("accepts the 2706 B worst case with 16 refs and a 16-digit sequence", () => {
    const ref = "artifact:" + "a".repeat(64) + "@sha256:" + "f".repeat(64);
    const worst = { ...d, batchId: "a".repeat(64), cohortRef: "c".repeat(64), sequence: 9_007_199_254_740_991, storeOracleRefs: Array(16).fill(ref) };
    expect(Buffer.byteLength(JSON.stringify(worst))).toBe(2706);
    expect(val(worst).ok).toBe(true);
  });

  it("derives late and overlapping declarations at set level", () => {
    const mk = (x: Record<string, unknown>) => (val({ ...d, ...x }) as unknown as { value: never }).value;
    const a = mk({ batchId: "a", sequence: 1, startUtc: iso(600_000), endUtc: iso(1_200_000) });
    const b = mk({ batchId: "b", sequence: 2, startUtc: iso(1_100_000), endUtc: iso(1_800_000) });
    const c = mk({ batchId: "c", sequence: 3, startUtc: iso(1_800_000), endUtc: iso(2_400_000), declaredAtUtc: iso(1_800_000) });
    const other = mk({ batchId: "x", metric: "M-05", sequence: 1, startUtc: iso(600_000), endUtc: iso(1_200_000) });
    const r = declarationSetReasons([a, b, c, other]);
    expect(r.get("a")).toEqual(["overlapping_batch"]);
    expect(r.get("b")).toEqual(["overlapping_batch"]);
    expect(r.get("c")).toEqual(["undeclared_batch"]);
    expect(r.has("x")).toBe(false);
    const inverted = declarationSetReasons([mk({ batchId: "p", sequence: 2 }), mk({ batchId: "q", sequence: 1, startUtc: iso(1_200_000), endUtc: iso(1_800_000) })]);
    expect(inverted.get("p")).toEqual(["overlapping_batch"]);
  });
});
