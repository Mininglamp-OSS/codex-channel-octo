import { describe, expect, it } from "vitest";
import {
  CONTROLLED_FAILURE_CASE_IDS, actionSignalValid, evaluateBatch, openSelectedOutputEvidence,
  type BatchDeclaration, type EvaluationReceipt, type EvidenceBinding,
} from "../cards/telemetry.js";
import {
  BIND, BOT, BOT2, K, O, ORIGIN2, PROFILE, RT, W, declare, dep, harness, li, openFor, rec, type Harness,
} from "./fixtures/telemetry-harness.js";
import {
  CASE_IDS, FINAL, HIST, OTHER, allCases, caseRecord, findingRecord, headerRecord, type CaseId,
} from "./fixtures/selected-output-fixtures.js";

void K;

/** One cooldown at origin O: #16 at 100 s, #17 slices to 220 s, #31 at 220 s. */
function withCooldown(h: Harness): void {
  h.beats(100_000);
  h.sink.emit("cooldown_start_total", { origin_ref: O, code: "server_retry_after" }, 1);
  h.beats(160_000);
  h.sink.emitInterval("cooldown_slice_ms", { origin_ref: O, code: "server_retry_after" }, 1000.5 + 100_000, 1000.5 + 160_000);
  h.beats(220_000);
  h.sink.emitInterval("cooldown_slice_ms", { origin_ref: O, code: "server_retry_after" }, 1000.5 + 160_000, 1000.5 + 220_000);
  h.sink.emit("cooldown_end_total", { origin_ref: O, code: "elapsed" }, 1);
}

interface World { receipt: EvaluationReceipt; decl: BatchDeclaration; lines: string[]; live: unknown[]; D: unknown }
function world(opts: { cooldown?: boolean; evalT?: number; twin?: boolean } = {}): World {
  const until = opts.evalT ?? 3_000_000;
  const h = harness(0);
  if (opts.cooldown !== false) withCooldown(h);
  h.beats(until);
  const lines = [...h.lines];
  const live: unknown[] = [rec("s1", [li(h, 0, 0, "running", 1)])];
  let D = dep({ s1: [0] });
  if (opts.twin) {
    const t = harness(0);
    withCooldown(t);
    t.beats(until);
    lines.push(...t.lines);
    live.push(rec("s2", [li(t, 0, 0, "running", 1)]));
    D = dep({ s1: [0], s2: [0] });
  }
  return { receipt: openFor(lines, live, D, until), decl: declare({ metric: "M-05", start: 0, end: W }), lines, live, D };
}

const open = (w: World, over: { header?: unknown; cases?: unknown; findings?: unknown; binding?: EvidenceBinding; declaration?: unknown; receipt?: unknown } = {}) =>
  openSelectedOutputEvidence({
    declaration: (over.declaration ?? w.decl) as BatchDeclaration, receipt: (over.receipt ?? w.receipt) as EvaluationReceipt,
    binding: over.binding ?? BIND, header: over.header ?? headerRecord(), cases: (over.cases ?? allCases()) as unknown[],
    ...(over.findings === undefined ? {} : { findings: over.findings as unknown[] }),
  });
const score = (w: World, opened: ReturnType<typeof open>, binding: EvidenceBinding = BIND, receipt = w.receipt, decl = w.decl) =>
  evaluateBatch(decl, receipt, { binding, selectedOutput: opened.evidence });
const rules = (opened: ReturnType<typeof open>) => opened.diagnostics.map((d) => d.rule);
const withCase = (id: CaseId, over: Record<string, unknown>) => allCases({ [id]: over });

describe("M-05 selected-output evidence (v16-A / v24)", () => {
  it("closes the controlled-failure case set to exactly the six v24 ids", () => {
    expect([...CONTROLLED_FAILURE_CASE_IDS]).toEqual([...CASE_IDS]);
    expect(Object.isFrozen(CONTROLLED_FAILURE_CASE_IDS)).toBe(true);
  });

  it("P0: passes with 30 normal turns, six valid cases and no card-caused fault", () => {
    const w = world();
    const opened = open(w);
    expect(opened.diagnostics).toEqual([]);
    expect(opened.criticals).toEqual([]);
    expect(Object.isFrozen(opened.evidence)).toBe(true);
    expect(score(w, opened)).toMatchObject({ metric: "M-05", status: "pass", reasons: [] });
  });

  it("keeps M-05 fail-closed without selected-output evidence", () => {
    const w = world();
    expect(evaluateBatch(w.decl, w.receipt, { binding: BIND })).toMatchObject({ status: "invalid", reasons: ["insufficient_samples"] });
  });

  it("N1/N2: rejects unknown and v24-excluded case ids", () => {
    const w = world();
    for (const id of ["partial_segment_delivery_failures", "ordinary_successful_final_delivery", "timeout_late_selected_answer", "send_unconfirmed"]) {
      const cases = allCases();
      cases[0] = caseRecord("partial_segment_delivery_failure", { caseId: id });
      const opened = open(w, { cases });
      expect(rules(opened)).toEqual(["unknown_case_id", "missing_case_id"]);
      expect(score(w, opened)).toMatchObject({ status: "invalid", reasons: ["missing_case_id", "unknown_case_id"] });
      expect(JSON.stringify(opened.diagnostics)).not.toContain(id);
    }
  });

  it("N3/N4: every omission is missing_case_id and every duplicate is duplicate_case_id", () => {
    const w = world();
    CASE_IDS.forEach((id, i) => {
      const without = allCases().filter((_, j) => j !== i);
      const missing = open(w, { cases: without });
      expect([id, rules(missing)]).toEqual([id, ["missing_case_id"]]);
      expect(score(w, missing).reasons).toEqual(["missing_case_id"]);
      const twice = [...allCases(), caseRecord(id)];
      const dup = open(w, { cases: twice });
      expect([id, rules(dup)]).toEqual([id, ["duplicate_case_id"]]);
      expect(score(w, dup).status).toBe("invalid");
    });
  });

  it("N9: requires 30 normal selected-output turns; controlled cases never count", () => {
    const w = world();
    const at = (n: number) => open(w, { header: headerRecord({ selectedOutputTurns: n }) });
    expect(rules(at(29))).toEqual(["insufficient_samples"]);
    expect(score(w, at(29)).reasons).toEqual(["insufficient_samples"]);
    expect(score(w, at(30)).status).toBe("pass");
    expect(score(w, at(24)).reasons).toEqual(["insufficient_samples"]);
  });

  it("rejects nonfinite, fractional, unsafe and wrongly typed counts", () => {
    const w = world();
    expect(rules(open(w, { header: headerRecord({ selectedOutputTurns: 30.5 }) }))).toEqual(["grammar"]);
    expect(rules(open(w, { header: headerRecord({ selectedOutputTurns: -30 }) }))).toEqual(["grammar"]);
    expect(rules(open(w, { header: headerRecord({ selectedOutputTurns: "30" }) }))).toEqual(["wrong_type"]);
    expect(rules(open(w, { header: headerRecord({ selectedOutputTurns: null }) }))).toEqual(["null_value"]);
    // Non-finite literals never reach the schema: the WP-01 strict parser rejects them.
    expect(rules(open(w, { header: headerRecord().replace('"selectedOutputTurns":30', '"selectedOutputTurns":1e400') }))).toEqual(["malformed_json"]);
    expect(rules(open(w, { header: headerRecord().replace('"selectedOutputTurns":30', '"selectedOutputTurns":1e300') }))).toEqual(["grammar"]);
    expect(rules(open(w, { header: headerRecord().replace('"selectedOutputTurns":30', '"selectedOutputTurns":9007199254740993') }))).toEqual(["malformed_json"]);
    const frac = open(w, { cases: withCase("partial_segment_delivery_failure", { ackedSegments: 0.5 }) });
    expect(rules(frac)).toEqual(["grammar", "missing_case_id"]);
    expect(score(w, frac).reasons).toEqual(["missing_case_id", "missing_evidence"]);
    expect(score(w, open(w, { header: headerRecord({ selectedOutputTurns: 30.5 }) })).reasons).toEqual(["missing_evidence"]);
  });

  it("N10/N12: requires every evidence reference and admits no unknown field, URL, payload or secret", () => {
    const w = world();
    const noRef = open(w, { header: headerRecord({ selectedOutputRef: undefined }) });
    expect(rules(noRef)).toEqual(["missing_field"]);
    expect(score(w, noRef).reasons).toEqual(["missing_evidence"]);
    const noCaseRef = open(w, { cases: withCase("missing_message_identity", { evidenceRef: undefined }) });
    expect(rules(noCaseRef)).toEqual(["missing_field", "missing_case_id"]);
    expect(score(w, noCaseRef).reasons).toEqual(["missing_case_id", "missing_evidence"]);
    expect(rules(open(w, { cases: withCase("host_network_card_api_outage_restored", { faultRef: undefined }) }))).toEqual(["missing_field", "missing_case_id"]);
    expect(rules(open(w, { cases: withCase("card_write_http_429_cooldown", { clockRef: undefined }) }))).toEqual(["missing_field", "missing_case_id"]);
    const canaries: Record<string, unknown>[] = [
      { payloadText: "CANARY final answer" }, { evidenceRef: "https://user:pw@canary.example.com/a?b" },
      { apiOrigin: "https://api.example.com:443/v1/canary" }, { fixtureRevision: "sk-CANARYCANARY@v1" },
      { historyDigest: "CANARY".padEnd(64, "x") }, { capability: "CANARY" },
    ];
    for (const c of canaries) {
      const opened = open(w, { cases: withCase("all_segment_delivery_failure", c) });
      expect(score(w, opened).status).toBe("invalid");
      expect(JSON.stringify(opened)).not.toContain("CANARY");
      expect(JSON.stringify(opened.diagnostics)).not.toMatch(/canary|payloadText|https/i);
    }
    expect(rules(open(w, { cases: withCase("all_segment_delivery_failure", { payloadText: "x" }) }))[0]).toBe("unknown_field");
    expect(rules(open(w, { cases: withCase("all_segment_delivery_failure", { apiOrigin: "https://api.example.com:443/v1" }) }))[0]).toBe("not_canonical_origin");
  });

  it("N8: invalidates every binding field, the snapshot, the declaration and the receipt", () => {
    const w = world();
    const flip = (s: string) => (s[0] === "a" ? "b" : "a") + s.slice(1);
    const fields: Record<string, unknown>[] = [
      { candidateSha: flip("a".repeat(40)) }, { frozenBaselineSha: "c".repeat(40) }, { nodeVersion: "v22.11.1" },
      { codexSdkVersion: "0.142.4" }, { apiOrigin: ORIGIN2, profileHash: "0".repeat(64) }, { profileHash: "0".repeat(64) },
      { fixtureRevision: "m05-cases@v2" }, { harnessIdentity: "m05-harness@1.0.1" }, { batchId: "other" },
      { cohortRef: "other" }, { livenessBatchId: "b2" },
    ];
    for (const f of fields) {
      const viaCase = open(w, { cases: withCase("missing_message_identity", f) });
      expect([f, rules(viaCase)]).toEqual([f, ["binding_mismatch"]]);
      expect(score(w, viaCase).reasons).toEqual(["binding_mismatch"]);
      const viaHeader = open(w, { header: headerRecord(f) });
      expect(rules(viaHeader)).toContain("binding_mismatch");
      expect(score(w, viaHeader).status).toBe("invalid");
    }
    const outside = open(w, { cases: withCase("progress_card_send_edit_failure", { endUtc: new Date(Date.parse("2026-10-15T08:10:00.000Z")).toISOString() }) });
    expect(rules(outside)).toEqual(["binding_mismatch"]);
    const opened = open(w);
    const fresh = openFor(w.lines, w.live, w.D);
    expect(score(w, opened, BIND, fresh).reasons).toEqual(["binding_mismatch"]);
    expect(score(w, open(w, { receipt: fresh }), BIND, fresh).status).toBe("pass");
    const otherDecl = declare({ metric: "M-05", start: 0, end: W });
    expect(score(w, opened, BIND, w.receipt, otherDecl).reasons).toEqual(["binding_mismatch"]);
    const otherBinding: EvidenceBinding = { ...BIND, frozenBaselineSha: "c".repeat(40) };
    expect(score(w, opened, otherBinding).reasons).toEqual(["binding_mismatch"]);
    expect(evaluateBatch(w.decl, w.receipt, { binding: BIND, selectedOutput: { ...opened.evidence } as never }).reasons).toEqual(["binding_mismatch"]);
    expect(evaluateBatch(w.decl, w.receipt, { binding: BIND, selectedOutput: Object.freeze({}) as never }).reasons).toEqual(["binding_mismatch"]);
    expect(rules(open(w, { receipt: Object.freeze({}) }))).toContain("binding_mismatch");
    const env2: EvidenceBinding = { ...BIND, environments: new Map([[BOT, { runtime: RT, apiOrigin: ORIGIN2, profileHash: PROFILE }], [BOT2, { runtime: RT, apiOrigin: ORIGIN2, profileHash: PROFILE }]]) };
    expect(rules(open(w, { binding: env2 }))).toContain("binding_mismatch");
  });

  it("evaluates cases 1–3 predicates, including both case-3 alternatives", () => {
    const w = world();
    const c3 = (over: Record<string, unknown>) => open(w, { cases: withCase("missing_message_identity", over) });
    expect(score(w, c3({ turnOutcome: "unconfirmed" })).status).toBe("pass");
    expect(score(w, c3({ turnOutcome: "failed" })).status).toBe("pass");
    expect(rules(c3({ turnOutcome: "done" }))).toEqual(["outcome_mismatch"]);
    expect(rules(c3({ ackedSegments: 3 }))).toEqual(["outcome_mismatch"]);
    const resend = c3({ automaticResends: 1 });
    expect(rules(resend)).toEqual(["outcome_mismatch"]);
    expect(resend.criticals.map((s) => s.reason)).toEqual(["output_parity_mismatch"]);
    const c1 = (over: Record<string, unknown>) => open(w, { cases: withCase("partial_segment_delivery_failure", over) });
    const falseDone = c1({ turnOutcome: "done" });
    expect(rules(falseDone)).toEqual(["outcome_mismatch"]);
    expect(falseDone.criticals).toEqual([]);
    expect(rules(c1({ turnOutcome: "unconfirmed" }))).toEqual(["outcome_mismatch"]);
    expect(rules(c1({ ackedSegments: 3 }))).toEqual(["outcome_mismatch"]);
    const substituted = c1({ answerSubstituted: true });
    expect(substituted.criticals.map((s) => [s.metric, s.reason])).toEqual([["M-05", "output_parity_mismatch"]]);
    const history = c1({ historyDigest: OTHER });
    expect(rules(history)).toEqual(["outcome_mismatch"]);
    expect(history.criticals.map((s) => s.reason)).toEqual(["output_parity_mismatch"]);
    const c2 = open(w, { cases: withCase("all_segment_delivery_failure", { ackedSegments: 1 }) });
    expect(rules(c2)).toEqual(["outcome_mismatch"]);
    expect(rules(open(w, { cases: withCase("all_segment_delivery_failure", { ackedSegments: 4 }) }))).toEqual(["grammar", "missing_case_id"]);
  });

  it("N7/case 4: baseline-equivalent loss is not attributed; a card-caused loss or change is critical", () => {
    const w = world();
    const c4 = (over: Record<string, unknown>) => open(w, { cases: withCase("host_network_card_api_outage_restored", over) });
    const equivalent = c4({ finalDelivered: false, baselineFinalDelivered: false });
    expect(equivalent.diagnostics).toEqual([]);
    expect(equivalent.criticals).toEqual([]);
    expect(score(w, equivalent).status).toBe("pass");
    const lost = c4({ finalDelivered: false });
    expect(rules(lost)).toEqual(["outcome_mismatch"]);
    expect(lost.criticals.map((s) => s.reason)).toEqual(["card_lost_final"]);
    const changed = c4({ finalDigest: OTHER });
    expect(changed.criticals.map((s) => s.reason)).toEqual(["output_parity_mismatch"]);
    expect(score(w, changed)).toMatchObject({ status: "invalid", reasons: ["outcome_mismatch"] });
  });

  it("N6/case 5: final is never vetoed; generic status bound depends on the progress capability", () => {
    const w = world();
    const c5 = (over: Record<string, unknown>) => open(w, { cases: withCase("progress_card_send_edit_failure", over) });
    expect(score(w, c5({ progressEnabled: true, genericStatusCount: 0 })).status).toBe("pass");
    expect(score(w, c5({ progressEnabled: false, genericStatusCount: 0 })).status).toBe("pass");
    expect(rules(c5({ progressEnabled: true, genericStatusCount: 2 }))).toEqual(["outcome_mismatch"]);
    expect(rules(c5({ progressEnabled: false, genericStatusCount: 1 }))).toEqual(["outcome_mismatch"]);
    const vetoed = c5({ finalDelivered: false });
    expect(rules(vetoed)).toEqual(["outcome_mismatch"]);
    expect(vetoed.criticals).toHaveLength(1);
    expect(vetoed.criticals[0]).toMatchObject({ action: "disable_capability", metric: "M-05", reason: "card_lost_final", scope: { kind: "capability", capability: "automatic" } });
    expect(actionSignalValid(vetoed.criticals[0])).toBe(true);
  });

  it("N11/case 6: evaluates the collected cooldown, counting a shared origin cooldown once", () => {
    const none = world({ cooldown: false });
    const missing = open(none);
    expect(rules(missing)).toEqual(["outcome_mismatch"]);
    expect(missing.criticals).toEqual([]);
    const twin = world({ twin: true });
    const opened = open(twin);
    expect(opened.diagnostics).toEqual([]);
    expect(score(twin, opened).status).toBe("pass");
    const w = world();
    const elsewhere = open(w, { cases: withCase("card_write_http_429_cooldown", { startUtc: "2026-10-15T08:05:00.000Z", endUtc: "2026-10-15T08:06:00.000Z" }) });
    expect(rules(elsewhere)).toEqual(["outcome_mismatch"]);
  });

  it("emits card-caused criticals immediately while the batch horizon is pending", () => {
    const w = world({ evalT: 650_000 });
    expect(evaluateBatch(w.decl, w.receipt, { binding: BIND }).status).toBe("pending");
    const opened = open(w, { cases: withCase("progress_card_send_edit_failure", { finalDelivered: false }) });
    expect(opened.criticals.map((s) => s.reason)).toEqual(["card_lost_final"]);
    expect(score(w, opened).status).toBe("pending");
    const finding = open(w, { findings: [findingRecord({ code: "output_parity_mismatch", capability: "interaction" })] });
    expect(finding.criticals.map((s) => [s.reason, s.scope])).toEqual([["output_parity_mismatch", { kind: "capability", capability: "interaction" }]]);
  });

  it("fails a batch on a confirmed card-caused fault in normal turns", () => {
    const w = world();
    const opened = open(w, { findings: [findingRecord()] });
    expect(opened.diagnostics).toEqual([]);
    expect(opened.criticals.map((s) => s.reason)).toEqual(["card_lost_final"]);
    for (const s of opened.criticals) expect(actionSignalValid(s)).toBe(true);
    expect(score(w, opened)).toMatchObject({ status: "fail", reasons: [] });
    expect(rules(open(w, { findings: [findingRecord({ code: "synthetic_drill" })] }))).toEqual(["grammar"]);
    expect(rules(open(w, { findings: [findingRecord({ batchId: "other" })] }))).toEqual(["binding_mismatch"]);
    // No findings cap is approved: more than 16 confirmed faults are all kept (only diagnostics are capped at 16).
    expect(rules(open(w, { findings: Array(17).fill(findingRecord()) }))).toEqual([]);
  });

  it("fits worst-case records under the unchanged v15 4096-byte cap", () => {
    const sv = "1.0.0-" + "a".repeat(58);
    const ref = "artifact:" + "a".repeat(64) + "@sha256:" + "f".repeat(64);
    const longOrigin = "https://" + ("a".repeat(63) + ".").repeat(3) + "a".repeat(61) + ":65535";
    const widest = {
      batchId: "m".repeat(64), cohortRef: "c".repeat(64), livenessBatchId: "l".repeat(64), codexSdkVersion: sv, codexCliVersion: sv,
      nodeVersion: "v9999999.9999999.9999999", apiOrigin: longOrigin, templateFingerprint: "ai.reasoning-process@" + "Ab1.".repeat(16) + "#" + "d".repeat(64),
      fixtureRevision: "a".repeat(64) + "@" + "f".repeat(40), harnessIdentity: "a".repeat(64) + "@" + sv,
      clockRef: ref, topologyRef: ref, evidenceRef: ref, capability: "interaction",
    };
    // faultRef belongs to the outage case only; every other case rejects it as an unknown field.
    const widestFor = (id: CaseId) => (id === "host_network_card_api_outage_restored" ? { ...widest, faultRef: ref } : widest);
    const sizes = CASE_IDS.map((id) => Buffer.byteLength(caseRecord(id, widestFor(id))));
    expect(Math.max(...sizes)).toBeLessThan(4096);
    const header = headerRecord({ ...widest, clockRef: undefined, topologyRef: undefined, evidenceRef: undefined, capability: undefined, selectedOutputRef: ref, selectedOutputTurns: 9_007_199_254_740_991 });
    expect(Buffer.byteLength(header)).toBeLessThan(4096);
    // Grammar is accepted at full width; only binding (not size) rejects these synthetic values.
    const w = world();
    const opened = open(w, { header, cases: CASE_IDS.map((id) => caseRecord(id, widestFor(id))) });
    expect(new Set(rules(opened))).toEqual(new Set(["binding_mismatch"]));
  });

  it("is single-view and immutable against hostile inputs", () => {
    const w = world();
    let reads = 0;
    const input = {
      declaration: w.decl, receipt: w.receipt, binding: BIND, cases: allCases(),
      get header() { reads++; return reads === 1 ? headerRecord() : headerRecord({ selectedOutputTurns: 1 }); },
    };
    const opened = openSelectedOutputEvidence(input as never);
    expect(reads).toBe(1);
    expect(score(w, opened).status).toBe("pass");
    const cases = allCases();
    const opened2 = open(w, { cases });
    cases[0] = "{";
    expect(score(w, opened2).status).toBe("pass");
    expect(() => { (opened2.criticals as unknown[]).push(1); }).toThrow();
    const throwing = new Proxy([], { get: () => { throw new Error("CANARY"); } });
    const hostile = open(w, { cases: throwing });
    expect(score(w, hostile).status).toBe("invalid");
    expect(JSON.stringify(hostile)).not.toContain("CANARY");
    const many = open(w, { cases: Array(40).fill("{") });
    expect(many.diagnostics.length).toBeLessThanOrEqual(16);
    void HIST; void FINAL;
  });
});

describe("v24 follow-up: genuine partial split, uncapped criticals, single-read input", () => {
  it("requires a genuine partial split for case 1 and the >=2-segment fixture for cases 1-3", () => {
    const w = world();
    const at = (id: CaseId, over: Record<string, unknown>) => open(w, { cases: withCase(id, over) });
    const zeroAckedPartial = at("partial_segment_delivery_failure", { expectedSegments: 3, ackedSegments: 0 });
    expect(rules(zeroAckedPartial)).toEqual(["outcome_mismatch"]);
    expect(score(w, zeroAckedPartial).reasons).toEqual(["outcome_mismatch"]);
    expect(rules(at("partial_segment_delivery_failure", { expectedSegments: 1, ackedSegments: 0 }))).toEqual(["outcome_mismatch"]);
    expect(rules(at("all_segment_delivery_failure", { expectedSegments: 1, ackedSegments: 0 }))).toEqual(["outcome_mismatch"]);
    expect(rules(at("missing_message_identity", { expectedSegments: 1, ackedSegments: 0, turnOutcome: "failed" }))).toEqual(["outcome_mismatch"]);
    expect(score(w, at("partial_segment_delivery_failure", { expectedSegments: 2, ackedSegments: 1 })).status).toBe("pass");
    expect(score(w, at("all_segment_delivery_failure", { expectedSegments: 2, ackedSegments: 0 })).status).toBe("pass");
    expect(score(w, at("all_segment_delivery_failure", { expectedSegments: 3, ackedSegments: 0 })).status).toBe("pass");
    for (const turnOutcome of ["failed", "unconfirmed"]) {
      expect(score(w, at("missing_message_identity", { expectedSegments: 2, ackedSegments: 1, turnOutcome })).status).toBe("pass");
      expect(score(w, at("missing_message_identity", { expectedSegments: 2, ackedSegments: 0, turnOutcome })).status).toBe("pass");
    }
  });

  it("keeps every validated card-caused critical beyond 16 findings and next to invalid neighbours", () => {
    const w = world();
    const twenty = open(w, { findings: Array.from({ length: 20 }, (_, i) => findingRecord({ atUtc: new Date(Date.parse("2026-10-15T08:01:00.000Z") + i * 1000).toISOString() })) });
    expect(twenty.diagnostics).toEqual([]);
    expect(twenty.criticals).toHaveLength(20);
    for (const s of twenty.criticals) expect(actionSignalValid(s)).toBe(true);
    expect(score(w, twenty)).toMatchObject({ status: "fail", reasons: [] });
    const afterInvalid = open(w, { findings: [...Array(16).fill("{"), findingRecord({ code: "output_parity_mismatch" })] });
    expect(afterInvalid.diagnostics).toHaveLength(16);
    expect(afterInvalid.criticals.map((s) => s.reason)).toEqual(["output_parity_mismatch"]);
    const flood = open(w, { findings: [...Array(40).fill("{"), findingRecord(), ...Array(5).fill(findingRecord({ capability: "CANARY" }))] });
    expect(flood.diagnostics.length).toBeLessThanOrEqual(16);
    expect(flood.criticals.map((s) => s.reason)).toEqual(["card_lost_final"]);
    expect(JSON.stringify(flood)).not.toContain("CANARY");
    expect(score(w, flood).reasons).toEqual(["missing_evidence"]);
  });

  it("returns all criticals immediately while the batch horizon is pending", () => {
    const w = world({ evalT: 650_000 });
    const opened = open(w, { findings: [...Array(17).fill(findingRecord()), "{"] });
    expect(opened.criticals).toHaveLength(17);
    expect(opened.diagnostics.map((d) => d.rule)).toEqual(["malformed_json"]);
    expect(score(w, opened).status).toBe("pending");
  });

  it("reads every input field exactly once and contains throwing inputs", () => {
    const w = world();
    const reads: Record<string, number> = {};
    const once = (name: string, value: unknown) => ({ get: () => { reads[name] = (reads[name] ?? 0) + 1; return value; }, enumerable: true });
    const input = Object.defineProperties({}, {
      declaration: once("declaration", w.decl), receipt: once("receipt", w.receipt), binding: once("binding", BIND),
      header: once("header", headerRecord()), cases: once("cases", allCases()), findings: once("findings", [findingRecord()]),
    });
    const opened = openSelectedOutputEvidence(input as never);
    expect(reads).toEqual({ declaration: 1, receipt: 1, binding: 1, header: 1, cases: 1, findings: 1 });
    expect(opened.diagnostics).toEqual([]);
    expect(opened.criticals.map((s) => s.reason)).toEqual(["card_lost_final"]);
    expect(score(w, opened).status).toBe("fail");
    const boom = () => { throw new Error("CANARY-THROWN"); };
    for (const field of ["cases", "findings", "header"]) {
      const hostile = Object.defineProperties({ declaration: w.decl, receipt: w.receipt, binding: BIND, header: headerRecord(), cases: allCases() },
        { [field]: { get: boom, enumerable: true } });
      let result: ReturnType<typeof openSelectedOutputEvidence> | undefined;
      expect(() => { result = openSelectedOutputEvidence(hostile as never); }).not.toThrow();
      expect(JSON.stringify(result)).not.toContain("CANARY");
      expect(score(w, result!).status).toBe("invalid");
    }
    const proxyCases = new Proxy(allCases(), { get: (t, k) => { if (k === "length") throw new Error("CANARY-PROXY"); return Reflect.get(t, k); } });
    const proxied = open(w, { cases: proxyCases });
    expect(JSON.stringify(proxied)).not.toContain("CANARY");
    expect(score(w, proxied).status).toBe("invalid");
  });
});
