import { describe, expect, it } from "vitest";
import {
  batchSignals, cooldownComponents, evaluateBatch, evaluateM01, inspectEvaluation, openEvaluation, parseCollection,
  resumeAllowed, revise, validateEvidenceRecord, validateSourceAttestation, windowEvaluation,
  ACCEPTANCE_SUBIDS_V1, type ChainEntry, type EvaluationReceipt,
} from "../cards/telemetry.js";
import {
  ART, B, BASE_SHA, BIND, BOT, C, COH, K, O, O2, ORIGIN, PROFILE, RT, SHA, W, closed, declare, dep, done, ev, harness,
  healthy, iso, li, openFor, pr, rec, retryAfter, running, type Harness,
} from "./fixtures/telemetry-harness.js";

const FF = { bot_ref: BOT, origin_ref: O, route_type: "dm", capability: "automatic" };
const reasonsOf = (r: EvaluationReceipt) => inspectEvaluation(r)!.problems.map((p) => p.reason);

/** One healthy running process s1 with `fill` invoked at time 60 s, evaluated well after the horizon. */
function scenario(fill: (h: Harness) => void, until = 3_000_000) {
  const h = harness(0);
  h.beats(60_000);
  fill(h);
  h.beats(until);
  const live = [rec("s1", [li(h, 0, 0, "running", 1)])];
  const D = dep({ s1: [0] });
  return { h, live, D, receipt: openFor(h.lines, live, D, until) };
}

describe("strict collection parsing (§3.7)", () => {
  it("parses sink output and ignores unrelated log lines", () => {
    const h = healthy(0, 120_000);
    const c = parseCollection(["plain log line", ...h.lines, "[cards] other prefix"]);
    expect(c.parseFault).toBe(false);
    expect(c.lines.map((o) => o.seq)).toEqual([1, 2, 3, 4]);
    expect(c.lines[0].d).toBe(B);
    expect(Object.isFrozen(c.lines[0])).toBe(true);
  });

  it("sets a sticky parse fault for malformed prefixed input without retaining its bytes", () => {
    const good = healthy(0, 60_000).lines;
    const body = good[0].slice(15);
    const bad = [
      "[cards-metric]" + body, "[cards-metric] " + body.slice(0, 40) + "CANARY_TORN", "[cards-metric] " + body.replace('"seq":1', '"seq":0'),
      "[cards-metric] " + body.replace('"level":"info"', '"level":"warn"'), "[cards-metric] " + body.replace("{", '{"x":1,'),
      "[cards-metric] " + body.replace('"seq":1', '"seq":1,"seq":2'), "[cards-metric] " + body.replace('"seq":1', '"seq":9007199254740993'),
      "[cards-metric] " + body.replace('"value":1', '"value":2'), "[cards-metric] " + body + " ".repeat(1100),
      "[cards-metric] " + body.replace('"inc":"i', '"inc":"I'),
    ];
    for (const line of bad) {
      const c = parseCollection([...good, line]);
      expect(c.parseFault).toBe(true);
      expect(c.lines).toHaveLength(good.length);
      expect(JSON.stringify(c)).not.toContain("CANARY");
    }
    expect(parseCollection([...good, 7]).parseFault).toBe(true);
    expect(parseCollection("x" as never).parseFault).toBe(true);
  });

  it("quarantines scoring on a parse fault but keeps valid critical lines", () => {
    const h = harness();
    h.at(60_000);
    h.sink.emit("critical_signal_total", { capability: "display", code: "protected_token" }, 1);
    h.beats(3_000_000);
    const live = [rec("s1", [li(h, 0, 0, "running", 1)])];
    const r = openFor([...h.lines, "[cards-metric] {torn"], live, dep({ s1: [0] }));
    expect(inspectEvaluation(r)!.quarantined).toBe(true);
    const w0 = windowEvaluation(K, r);
    expect(w0.completeness).toBe("incomplete");
    expect(w0.signals.find((s) => s.action === "disable_capability")).toMatchObject({ metric: "M-01", reason: "protected_token", scope: { kind: "capability", capability: "display" } });
    expect(windowEvaluation(K + 3, r).completeness).toBe("incomplete");
  });
});

describe("evaluation context boundary (§5.3)", () => {
  const base = () => {
    const h = running(0);
    return { h, live: [rec("s1", [li(h, 0, 0, "running", 1)])], D: dep({ s1: [0] }) };
  };

  it("is pending for every missing or malformed prerequisite", () => {
    const { h, live, D } = base();
    const collection = parseCollection(h.lines);
    const ok = { collection, liveness: live, deployment: D, cohortRef: COH, livenessBatchId: "b1", evalUtc: B + 3_000_000, origins: [O, O2] };
    expect(windowEvaluation(K + 1, openEvaluation(ok)).completeness).toBe("complete");
    expect(windowEvaluation(K + 1, openEvaluation({ ...ok, evalUtc: B + 3_000_000.25 })).completeness).toBe("complete");
    const bad: Record<string, unknown>[] = [
      { evalUtc: undefined }, { evalUtc: null }, { evalUtc: String(B) }, { evalUtc: Number.NaN }, { evalUtc: Infinity },
      { evalUtc: -1 }, { evalUtc: 253_402_300_800_000 }, { evalUtc: B + 1000 }, { liveness: [] }, { liveness: null },
      { cohortRef: undefined }, { cohortRef: "Bad Cohort" }, { livenessBatchId: undefined }, { livenessBatchId: "B1!" },
      { origins: [] }, { origins: [O, O] }, { origins: ["https://api.example.com"] }, { graceMs: 600_001 }, { graceMs: 1.5 },
      { clockPolicy: "B" }, { collection: { lines: collection.lines, parseFault: false } }, { collection: { ...collection } },
    ];
    for (const patch of bad) {
      const r = openEvaluation({ ...ok, ...patch } as never);
      const w = windowEvaluation(K + 1, r);
      expect([patch, w.completeness, w.signals]).toEqual([patch, "pending", []]);
      expect(evaluateBatch(declare({ metric: "M-02", start: W, end: 2 * W }), r, { binding: BIND }).status).toBe("pending");
      expect(inspectEvaluation(r)!.problems).toEqual([{ kind: "count", s: 0, e: 253_402_300_799_999, reason: "telemetry_loss", quarantine: true }]);
    }
  });

  it("is pending when scoring restates a different context, and accepts an equal one", () => {
    const { h, live, D } = base();
    const collection = parseCollection(h.lines);
    const r = openEvaluation({ collection, liveness: live, deployment: D, cohortRef: COH, livenessBatchId: "b1", evalUtc: B + 3_000_000, origins: [O, O2] });
    const cover = new Set([pr("s1")]);
    const same = { evalUtc: B + 3_000_000, cohortRef: COH, livenessBatchId: "b1", deployment: D, livenessCover: cover, origins: [O2, O], clockPolicy: "A" as const, graceMs: null, collection, liveness: live };
    expect(windowEvaluation(K + 1, r, same).completeness).toBe("complete");
    const diffs: Record<string, unknown>[] = [
      { evalUtc: B + 3_000_001 }, { cohortRef: "other" }, { livenessBatchId: "b2" }, { deployment: dep({ s1: [1] }) },
      { livenessCover: new Set() }, { livenessCover: [pr("s1")] }, { origins: [O] }, { clockPolicy: "C" }, { graceMs: 0 },
      { collection: parseCollection(h.lines) }, { liveness: [rec("s1", [li(h, 0, 0, "running", 2)])] },
    ];
    for (const d of diffs) expect([d, windowEvaluation(K + 1, r, { ...same, ...d } as never).completeness]).toEqual([d, "pending"]);
    expect(windowEvaluation(K + 1, Object.freeze({}) as never).completeness).toBe("pending");
    expect(windowEvaluation(K + 1, { ...r } as never).completeness).toBe("pending");
    expect(inspectEvaluation({} as never)).toBeNull();
  });

  it("consumes one serialized view: later caller mutation cannot change scoring", () => {
    const { h, live, D } = base();
    const r = openFor(h.lines, live, D);
    (live[0].processes[0].incarnations[0] as { exit: string }).exit = "unclean";
    expect(windowEvaluation(K + 1, r).completeness).toBe("complete");
  });
});

describe("evaluation identity (§I.1)", () => {
  const two = () => {
    const a = running(0);
    const b = running(0);
    return { lines: [...a.lines, ...b.lines], r1: rec("s1", [li(a, 0, 0, "running", 1)]), r2: rec("s2", [li(b, 0, 0, "running", 1)]), D: dep({ s1: [0], s2: [0] }) };
  };
  const faultsOf = (lines: string[], live: unknown[], D: unknown) => {
    const r = openFor(lines, live, D);
    const b = evaluateBatch(declare({ metric: "M-02", start: W, end: 2 * W }), r, { binding: BIND });
    return { faults: inspectEvaluation(r)!.identityFaults, w: windowEvaluation(K + 1, r).completeness, batch: b.status, reasons: b.reasons };
  };

  it("quarantines identity and coverage faults with their exact reasons", () => {
    const { lines, r1, r2, D } = two();
    const healthyRun = faultsOf(lines, [r1, r2], D);
    expect(healthyRun.faults).toEqual([]);
    const cases: [unknown[], unknown, string][] = [
      [[r1, r2], null, "missing_environment_evidence"],
      [[r1, r2], { ...D, extra: 1 }, "missing_environment_evidence"],
      [[r1, r2], dep({ s1: [0], s2: [0] }, "other"), "liveness_identity_mismatch"],
      [[r1, { ...r2, cohortRef: "other" }], D, "liveness_identity_mismatch"],
      [[r1, rec("s9", r2.processes[0].incarnations)], D, "liveness_identity_mismatch"],
      [[r1, r2, { ...r2, processes: [{ ...r2.processes[0], incarnations: [{ ...r2.processes[0].incarnations[0], inc: "i" + "9".repeat(16) }] }] }], D, "liveness_identity_mismatch"],
      [[r1, { ...r2, batchId: "b2" }], D, "liveness_identity_mismatch"],
      [[r1], D, "missing_liveness_evidence"],
      [[r1, { ...r2, extra: 1 }], D, "liveness_invalid"],
    ];
    for (const [live, d, fault] of cases) {
      const res = faultsOf(lines, live, d);
      expect([fault, res.faults.includes(fault as never), res.w, res.batch, res.reasons.includes(fault as never)]).toEqual([fault, true, "incomplete", "invalid", true]);
    }
  });

  it("checks the snapshot id against every record", () => {
    const { lines, r1, r2, D } = two();
    const r = openEvaluation({ collection: parseCollection(lines), liveness: [{ ...r1, batchId: "b2" }, { ...r2, batchId: "b2" }], deployment: D, cohortRef: COH, livenessBatchId: "b1", evalUtc: B + 3_000_000, origins: [O] });
    expect(inspectEvaluation(r)!.identityFaults).toEqual(["liveness_identity_mismatch"]);
  });
});

describe("per-slot history and stop anchor (§I.2)", () => {
  const hist = (live: unknown[], D: unknown, lines: string[] = []) => inspectEvaluation(openFor(lines, live, D))!.identityFaults;
  const slot = (incs: ReturnType<typeof li>[], slots: Record<string, [number, number?]>) => hist([rec("s1", incs)], dep(slots));

  it("enforces I-H1…I-H3", () => {
    expect(slot([li(null, 0, 1000, "clean", 1), li(null, 2000, 0, "running", 2)], { s1: [0] })).toEqual([]);
    const noStart = dep({ s1: [0] });
    delete (noStart.processes[0] as { firstStartUtc?: string }).firstStartUtc;
    expect(hist([rec("s1", [li(null, 0, 0, "running", 1)])], noStart)).toEqual(["missing_liveness_evidence"]);
    expect(hist([rec("s1", [li(null, 0, 0, "running", 1)])], { ...dep({ s1: [0] }), firstIncarnationStartUtc: iso(5) })).toEqual(["liveness_identity_mismatch"]);
    expect(slot([{ ...li(null, 0, 0, "running", 1), ordinal: undefined }], { s1: [0] })).toEqual(["missing_liveness_evidence"]);
    expect(slot([li(null, 0, 1000, "clean", 1), li(null, 2000, 0, "running", 3)], { s1: [0] })).toEqual(["missing_liveness_evidence"]);
    expect(slot([li(null, 0, 1000, "clean", 2), li(null, 2000, 0, "running", 1)], { s1: [0] })).toEqual(["liveness_identity_mismatch", "missing_liveness_evidence"]);
    expect(slot([li(null, 0, 1000, "clean", 1), li(null, 2000, 0, "running", 1)], { s1: [0] })).toEqual(["liveness_identity_mismatch", "missing_liveness_evidence"]);
    expect(slot([li(null, 500, 0, "running", 1)], { s1: [0] })).toEqual(["missing_liveness_evidence"]);
    expect(slot([li(null, 0, 0, "running", 1)], { s1: [500] })).toEqual(["liveness_identity_mismatch"]);
  });

  it("enforces the I-H5 stop anchor", () => {
    expect(slot([li(null, 0, 1000, "clean", 1)], { s1: [0, 1000] })).toEqual([]);
    expect(slot([li(null, 0, 1000, "clean", 1)], { s1: [0] })).toEqual(["missing_liveness_evidence"]);
    expect(slot([li(null, 0, 1000, "clean", 1)], { s1: [0, 2000] })).toEqual(["missing_liveness_evidence"]);
    expect(slot([li(null, 0, 1000, "clean", 1)], { s1: [0, 500] })).toEqual(["liveness_identity_mismatch"]);
    expect(slot([li(null, 0, 0, "running", 1)], { s1: [0, 500] })).toEqual(["liveness_identity_mismatch"]);
  });
});

describe("v15 decisive scenarios (A-0 limit, controls, NB-7)", () => {
  const setup = () => {
    const a0 = healthy(0, 50_000);
    const b = running(210_000);
    const c1 = retryAfter(60_000);
    return {
      L: [...a0.lines, ...b.lines], r1: rec("s1", [li(a0, 0, 50_000, "clean", 1)]), r2: rec("s2", [li(b, 210_000, 0, "running", 1)]),
      r3: rec("s3", [li(c1, 60_000, 200_000, "clean", 1)]),
    };
  };

  it("V15-W1: a listed slot that lost a Retry-After is incomplete with the h + 30 d hold", () => {
    const { L, r1, r2, r3 } = setup();
    const r = ev(L, [r1, r2, r3], dep({ s1: [0, 50_000], s2: [210_000], s3: [60_000, 200_000] }));
    expect(closed(r)).toBe(true);
    expect(r.hold).toBe(true);
    expect(r.m05).toEqual([[-62_000, 2_592_200_000]]);
    expect(r.validity).toEqual(["telemetry_loss"]);
  });

  it("V15-W2 stated limit: a slot omitted from both records is not detectable", () => {
    const { L, r1, r2 } = setup();
    const r = ev(L, [r1, r2], dep({ s1: [0, 50_000], s2: [210_000] }));
    expect(done(r)).toBe(true);
    expect(r.hold).toBe(false);
  });

  it("V15-W3: a DeploymentRecord-only slot fails closed", () => {
    const { L, r1, r2 } = setup();
    const r = ev(L, [r1, r2], dep({ s1: [0, 50_000], s2: [210_000], s3: [60_000, 200_000] }));
    expect(closed(r)).toBe(true);
    expect(r.validity).toEqual(["missing_liveness_evidence", "telemetry_loss"]);
    expect(r.q).toBe(true);
  });

  it("V15-W4: surviving lines of an unlisted slot mark only their own span", () => {
    const { L, r1, r2 } = setup();
    const c = harness(60_000);
    c.beats(200_000);
    c.sink.closeSink();
    const D = dep({ s1: [0, 50_000], s2: [210_000] });
    const receipt = openFor([...L, ...c.lines], [r1, r2], D);
    expect(windowEvaluation(K, receipt).completeness).toBe("incomplete");
    expect(inspectEvaluation(receipt)!.problems.filter((p) => p.reason === "unexpected_incarnation").map((p) => [p.s - B, p.e - B])).toEqual([[60_000, 200_000]]);
    const r = ev([...L, ...c.lines], [r1, r2], D);
    expect(r.w).toEqual(["complete", "complete", "complete"]);
    expect(r.hold).toBe(false);
  });

  it("V15-NB7: a misstated running exit is detected only after the 90 s window", () => {
    const a2 = healthy(0, 400_000);
    retryAfter(410_000, 450_000, 600_000);
    const b = running(210_000);
    const L = [...a2.lines, ...b.lines];
    const live = [rec("s1", [li(a2, 0, 0, "running", 1)]), rec("s2", [li(b, 210_000, 0, "running", 1)])];
    const D = dep({ s1: [0], s2: [210_000] });
    const at = (t: number) => {
      const lines = L.filter((l) => Date.parse(JSON.parse(l.slice(15)).t_utc) - B <= t);
      const probs = inspectEvaluation(openFor(lines, live, D, t))!.problems;
      return { hold: probs.some((p) => p.scope === "M-05" && p.e - B >= 200_000 + C), loss: probs.some((p) => p.reason === "telemetry_loss") };
    };
    expect(at(460_000)).toEqual({ hold: false, loss: false });
    expect(at(520_000)).toEqual({ hold: true, loss: true });
  });
});

describe("loss attribution, tails and acknowledgement trust (§3.8)", () => {
  it("adds a lifetime gap and cohort tail for a listed incarnation with zero lines", () => {
    const lost = harness(0);
    lost.drop = () => true;
    lost.beats(300_000);
    lost.sink.closeSink();
    const b = running(0);
    const probs = inspectEvaluation(openFor(b.lines, [rec("s1", [li(lost, 0, 300_000, "clean", 1)]), rec("s2", [li(b, 0, 0, "running", 1)])], dep({ s1: [0, 300_000], s2: [0] })))!.problems;
    expect(probs.filter((p) => p.reason === "telemetry_loss").map((p) => [p.kind, p.s - B, p.e - B, p.scope ?? null]))
      .toEqual([["gap", -1, 300_001, null], ["div", -122_000, 300_000 + C, "M-05"]]);
  });

  it("attributes prefix, interior and close losses on the fixed timeline", () => {
    const h = harness(0);
    h.drop = (l) => l.includes('"seq":3,');
    h.beats(240_000);
    h.sink.closeSink();
    h.lines.splice(h.lines.length - 1, 1);
    const probs = inspectEvaluation(openFor(h.lines, [rec("s1", [li(h, 0, 240_000, "clean", 1)])], dep({ s1: [0, 240_000] })))!.problems;
    const seqGap = probs.find((p) => p.seqGap);
    expect([seqGap!.s - B, seqGap!.e - B]).toEqual([60_000 - 122_000, 180_000]);
    const tail = probs.find((p) => p.kind === "div" && !p.seqGap && !p.scope);
    expect([tail!.s - B, tail!.e - B]).toEqual([240_000 - 122_000, 240_001]);
  });

  it("narrows a tail only with a later eligible acknowledgement at every cohort origin", () => {
    const run = (listed: boolean, ackAt: number, origins = [O, O2]) => {
      const lost = retryAfter(0, 50_000, 100_000);
      const ack = harness(0);
      ack.at(ackAt);
      for (const org of origins) ack.sink.emit("card_send_total", { bot_ref: BOT, origin_ref: org, capability: "display", code: "acked" }, 1);
      ack.beats(3_000_000);
      const live = [rec("s1", [li(lost, 0, 100_000, "clean", 1)]), ...(listed ? [rec("s2", [li(ack, 0, 0, "running", 1)])] : [])];
      const D = dep(listed ? { s1: [0, 100_000], s2: [0] } : { s1: [0, 100_000] });
      return inspectEvaluation(openFor(ack.lines, live, D))!.problems.filter((p) => p.scope === "M-05").map((p) => p.e - B);
    };
    // The lost incarnation has zero surviving lines: one tail (start − R, h + C] with h = its end (100 s).
    expect(run(true, 200_000)).toEqual([200_000]);
    expect(run(true, 200_000, [O])).toEqual([100_000 + C]);
    expect(run(true, 100_000)).toEqual([100_000 + C]);
    expect(run(true, 100_001)).toEqual([100_001]);
    expect(run(false, 200_000)).toEqual([100_000 + C]);
  });

  it("latches policy A divergence; policy C has no divergence check", () => {
    for (const policy of ["A", "C"] as const) {
      const h = harness(0, policy);
      h.beats(120_000);
      h.wallOffset = 1_700_000;
      h.beats(240_000);
      h.wallOffset = 0;
      h.beats(400_000);
      h.sink.closeSink();
      const live = [rec("s1", [{ ...li(h, 0, 400_000, "clean", 1), clockPolicy: policy }])];
      const probs = inspectEvaluation(openFor(h.lines, live, dep({ s1: [0, 400_000] }), 3_000_000, { clockPolicy: policy }))!.problems;
      const div = probs.filter((p) => p.reason === "clock_divergence").map((p) => [p.s - B, p.e - B]);
      expect(div).toEqual(policy === "A" ? [[120_000, 180_000], [180_000, 240_000], [240_000, 300_000], [300_000, 360_000]] : []);
    }
  });

  it("marks unclean incarnations and quarantines a lifetime violation", () => {
    const h = harness(0);
    h.beats(200_000);
    const live = [rec("s1", [li(h, 0, 200_000, "unclean", 1)])];
    expect(reasonsOf(openFor(h.lines, live, dep({ s1: [0, 200_000] })))).toContain("incarnation_unclean");
    const early = [rec("s1", [li(h, 0, 100_000, "clean", 1)])];
    expect(inspectEvaluation(openFor(h.lines, early, dep({ s1: [0, 100_000] })))!.quarantined).toBe(true);
  });

  it("excuses a startup stall only under the O-11l B grace", () => {
    const run = (graceMs: number | null) => {
      const h = harness(0);
      h.at(120_000);
      h.sink.heartbeat();
      h.beats(1_200_000);
      return inspectEvaluation(openFor(h.lines, [rec("s1", [li(h, 0, 0, "running", 1)])], dep({ s1: [0] }), 1_200_000, { graceMs }))!
        .problems.filter((p) => p.kind === "gap").length;
    };
    expect(run(null)).toBe(1);
    expect(run(600_000)).toBe(0);
    expect(run(60_000)).toBe(1);
  });
});

describe("horizon (O-11o A)", () => {
  it("keeps a window pending until a line at b + 62 s or evalUtc ≥ b + 152 s", () => {
    const h = harness(0);
    h.beats(600_000 + 61_000);
    const live = [rec("s1", [li(h, 0, 0, "running", 1)])];
    expect(windowEvaluation(K, openFor(h.lines, live, dep({ s1: [0] }), 661_000)).completeness).toBe("pending");
    h.beats(721_000);
    expect(windowEvaluation(K, openFor(h.lines, live, dep({ s1: [0] }), 721_000)).completeness).toBe("complete");
    const silent = harness(0);
    silent.beats(540_000);
    const live2 = [rec("s1", [li(silent, 0, 0, "running", 1)])];
    expect(windowEvaluation(K, openFor(silent.lines, live2, dep({ s1: [0] }), 751_999)).completeness).toBe("pending");
    expect(windowEvaluation(K, openFor(silent.lines, live2, dep({ s1: [0] }), 752_000)).completeness).toBe("incomplete");
  });

  it("returns critical disables immediately even while pending", () => {
    const h = harness(0);
    h.at(10_000);
    h.sink.emit("critical_signal_total", { bot_ref: BOT, capability: "interaction", code: "duplicate_admission" }, 1);
    h.sink.emit("critical_signal_total", { capability: "automatic", code: "card_lost_final" }, 1);
    h.sink.emit("critical_signal_total", { capability: "display", code: "synthetic_drill" }, 1);
    h.sink.emit("critical_signal_total", { capability: "display", code: "event_stream_halt" }, 1);
    const w = windowEvaluation(K, openFor(h.lines, [rec("s1", [li(h, 0, 0, "running", 1)])], dep({ s1: [0] }), 20_000));
    expect(w.completeness).toBe("pending");
    expect(w.signals.map((s) => [s.metric, s.reason, s.scope])).toEqual([
      ["M-04", "duplicate_admission", { kind: "capability", capability: "interaction", botRef: BOT }],
      ["M-05", "card_lost_final", { kind: "capability", capability: "automatic" }],
    ]);
    expect(w.drills).toEqual([{ action: "disable_capability", source: "drill", atUtc: iso(10_000), reason: "synthetic_drill", scope: { kind: "capability", capability: "display" } }]);
    expect(w.runtimeSignals).toEqual([{ code: "event_stream_halt", atUtc: iso(10_000) }]);
    const invalid = openEvaluation({ collection: parseCollection(h.lines), liveness: [], deployment: null, cohortRef: COH, livenessBatchId: "b1", evalUtc: Number.NaN, origins: [] });
    expect(windowEvaluation(K, invalid).signals).toHaveLength(2);
  });
});

describe("window triggers (§5.5)", () => {
  const sliceAll = (h: Harness, s: number, e: number) => {
    for (let t = s; t < e; t += 60_000) {
      h.beats(Math.min(t + 60_000, e));
      h.sink.emitInterval("cooldown_slice_ms", { origin_ref: O, code: "client_backoff" }, 1000.5 + t, 1000.5 + Math.min(t + 60_000, e));
    }
  };
  it("pauses an origin for 3 cooldowns ≥ 60 s or ≥ 300 s cumulative in one window, counting shared cooldowns once", () => {
    const h = harness(0);
    sliceAll(h, 0, 60_000);
    h.beats(120_000); sliceAll(h, 120_000, 180_000);
    h.beats(240_000); sliceAll(h, 240_000, 300_000);
    h.beats(3_000_000);
    const twin = harness(0);
    sliceAll(twin, 0, 60_000);
    twin.beats(3_000_000);
    const live = [rec("s1", [li(h, 0, 0, "running", 1)]), rec("s2", [li(twin, 0, 0, "running", 1)])];
    const r = openFor([...h.lines, ...twin.lines], live, dep({ s1: [0], s2: [0] }));
    expect(windowEvaluation(K, r).signals).toContainEqual({ action: "pause_expansion", metric: "M-05", source: "observed", atUtc: iso(W), reason: "cooldown_pause", scope: { kind: "origin", originRef: O } });
    expect(cooldownComponents(parseCollection([...h.lines, ...twin.lines]).lines).get(O)!.windows.get(K)).toEqual({ long: 3, cumulativeMs: 180_000 });
    const two = harness(0);
    sliceAll(two, 0, 60_000); two.beats(120_000); sliceAll(two, 120_000, 179_000); two.beats(3_000_000);
    expect(windowEvaluation(K, openFor(two.lines, [rec("s1", [li(two, 0, 0, "running", 1)])], dep({ s1: [0] }))).signals).toEqual([]);
    const cum = harness(0);
    sliceAll(cum, 0, 300_000); cum.beats(3_000_000);
    expect(cooldownComponents(parseCollection(cum.lines).lines).get(O)!.pauseWindows).toEqual([K]);
  });

  it("pauses M-03 and M-04 on their per-window counts", () => {
    const { receipt } = scenario((h) => {
      h.sink.emit("unreconciled_send_aged_total", { bot_ref: BOT, capability: "automatic" }, 2);
      h.sink.emit("unreconciled_send_aged_total", { bot_ref: BOT, capability: "display" }, 1);
      h.sink.emit("closure_edit_failed_total", { bot_ref: BOT, capability: "interaction", code: "gone" }, 2);
      h.sink.emit("action_disposition_total", { bot_ref: BOT, route_type: "group", code: "dead_letter" }, 2);
      h.sink.emit("unresolved_claim_aged_total", { bot_ref: BOT }, 1);
    });
    const sig = windowEvaluation(K, receipt).signals.map((s) => [s.metric, s.scope]);
    expect(sig).toEqual([
      ["M-03", { kind: "cohort", cohortRef: COH, capabilities: ["automatic", "display"] }],
      ["M-04", { kind: "cohort", cohortRef: COH, capabilities: ["interaction"] }],
    ]);
  });

  it("revises only toward caution", () => {
    const { receipt } = scenario(() => undefined);
    const complete = windowEvaluation(K + 1, receipt);
    expect(complete.completeness).toBe("complete");
    const incomplete = { ...complete, completeness: "incomplete" as const, signals: [{ action: "block_expansion_until_rerun" as const, metric: "completeness" as const, source: "observed" as const, atUtc: iso(2 * W), reason: "telemetry_loss" as const, scope: { kind: "cohort" as const, cohortRef: COH, capabilities: ["automatic" as const] } }] };
    const merged = revise(revise(null, incomplete), complete);
    expect(merged.completeness).toBe("incomplete");
    expect(merged.signals).toHaveLength(1);
    expect(revise(complete, { ...complete, completeness: "pending" }).completeness).toBe("complete");
  });

  it("keeps a timestamp-distinct critical observation added by a later cumulative evaluation", () => {
    const h = harness(0);
    h.beats(60_000);
    h.at(70_000);
    h.sink.emit("critical_signal_total", { capability: "display", code: "protected_token" }, 1);
    h.beats(75_000);
    const live = [rec("s1", [li(h, 0, 0, "running", 1)])];
    const D = dep({ s1: [0] });
    const first = windowEvaluation(K, openFor([...h.lines], live, D, 75_000));
    h.at(80_000);
    h.sink.emit("critical_signal_total", { capability: "display", code: "protected_token" }, 1);
    h.beats(3_000_000);
    const later = windowEvaluation(K, openFor(h.lines, live, D));
    const at = (w: typeof first) => w.signals.filter((s) => s.reason === "protected_token").map((s) => s.atUtc);
    expect(at(first)).toEqual([iso(70_000)]);
    expect(at(later)).toEqual([iso(70_000), iso(80_000)]);
    const revised = revise(revise(null, first), later);
    expect(at(revised)).toEqual([iso(70_000), iso(80_000)]);
    // Identical observations still collapse.
    expect(at(revise(revised, later))).toEqual([iso(70_000), iso(80_000)]);
  });

  it("keeps a confirmed event_stream_halt when a later collection no longer contains it", () => {
    const h = harness(0);
    h.beats(60_000);
    h.at(70_000);
    h.sink.emit("critical_signal_total", { capability: "display", code: "event_stream_halt" }, 1);
    h.beats(3_000_000);
    const live = [rec("s1", [li(h, 0, 0, "running", 1)])];
    const D = dep({ s1: [0] });
    const confirmed = windowEvaluation(K, openFor(h.lines, live, D));
    expect(confirmed.runtimeSignals).toEqual([{ code: "event_stream_halt", atUtc: iso(70_000) }]);
    const partial = windowEvaluation(K, openFor(h.lines.filter((l) => !l.includes('"code":"event_stream_halt"')), live, D));
    expect(partial.runtimeSignals).toEqual([]);
    expect(partial.completeness).toBe("incomplete");
    const revised = revise(confirmed, partial);
    expect(revised.runtimeSignals).toEqual([{ code: "event_stream_halt", atUtc: iso(70_000) }]);
    expect(revised.completeness).toBe("incomplete");
    expect(revise(revised, confirmed).runtimeSignals).toEqual([{ code: "event_stream_halt", atUtc: iso(70_000) }]);
  });
});

describe("batch scoring (§5.1–§5.3)", () => {
  const latency = (values: number[], extra?: (h: Harness) => void) => scenario((h) => {
    for (const v of values) h.sink.emit("first_frame_ms", FF, v);
    extra?.(h);
  });
  const m02 = (s: ReturnType<typeof scenario>, opts: Record<string, unknown> = {}) =>
    evaluateBatch(declare({ metric: "M-02", start: 0, end: W }), s.receipt, { binding: BIND, ...opts });
  const exRec = (count: number, code = "api_outage", origin = O) => JSON.stringify({
    metric: "M-02", batchId: "m", code, originRef: origin, startUtc: iso(30_000), endUtc: iso(90_000), durationMs: 60_000, excludedCount: count, measurementRef: ART,
  });

  it("passes at 29/30 within 3000 ms and fails at 28/30", () => {
    const pass = m02(latency([...Array(29).fill(3000), 3001]));
    expect(pass).toMatchObject({ status: "pass", reasons: [], latency: { eligible: 30, within: 29, passRequired: 29 } });
    expect(m02(latency([...Array(28).fill(10), 3001, 3001])).status).toBe("fail");
  });

  it("counts unacknowledged attempts as failures and requires 30 eligible", () => {
    const unacked = (h: Harness) => h.sink.emit("first_frame_unacked_total", { ...FF, code: "ambiguous" }, 2);
    expect(m02(latency(Array(28).fill(5), unacked))).toMatchObject({ status: "fail", latency: { eligible: 30, within: 28, unacked: 2 } });
    expect(m02(latency(Array(29).fill(5)))).toMatchObject({ status: "invalid", reasons: ["insufficient_samples"] });
    const inel = (h: Harness) => h.sink.emit("first_frame_ineligible_total", { bot_ref: BOT, route_type: "dm", code: "thinking_only" }, 5);
    expect(m02(latency(Array(29).fill(5), inel)).reasons).toEqual(["insufficient_samples"]);
  });

  it("applies the 10 % exclusion limit and exclusion reconciliation", () => {
    const excl = (n: number, code = "api_outage") => (h: Harness) => h.sink.emit("first_frame_excluded_total", { bot_ref: BOT, origin_ref: O, route_type: "dm", code }, n);
    expect(m02(latency(Array(30).fill(5), excl(3)), { exclusions: [exRec(3)] }).status).toBe("pass");
    expect(m02(latency(Array(30).fill(5), excl(4)), { exclusions: [exRec(4)] }).reasons).toEqual(["exclusion_over_limit"]);
    expect(m02(latency(Array(30).fill(5), excl(3))).reasons).toEqual(["exclusion_unrecorded"]);
    expect(m02(latency(Array(30).fill(5), excl(3)), { exclusions: [exRec(2)] }).reasons).toEqual(["exclusion_unrecorded"]);
    expect(m02(latency(Array(30).fill(5)), { exclusions: [exRec(1)] }).reasons).toEqual(["exclusion_unrecorded"]);
    expect(m02(latency(Array(30).fill(5), excl(3)), { exclusions: ["{bad"] }).reasons).toContain("exclusion_unrecorded");
    expect(m02(latency(Array(30).fill(5), excl(3, "server_cooldown")), { exclusions: [exRec(3, "server_cooldown")] }).reasons).toEqual(["exclusion_wrong_origin"]);
    const outside = JSON.stringify({ ...JSON.parse(exRec(3)), startUtc: iso(W - 1000), endUtc: iso(W + 1000), durationMs: 2000 });
    expect(m02(latency(Array(30).fill(5), excl(3)), { exclusions: [exRec(3), outside] }).reasons).toContain("exclusion_out_of_batch");
    expect(m02(latency(Array(30).fill(5), excl(3)), { exclusions: [exRec(2), exRec(1)] }).reasons).toContain("exclusion_overlap");
  });

  it("uses the 5000 ms terminal deadline for M-03", () => {
    const s = scenario((h) => {
      for (let i = 0; i < 29; i++) h.sink.emit("terminal_ms", { ...FF, capability: "interaction" }, 5000);
      h.sink.emit("terminal_ms", FF, 5001);
    });
    expect(evaluateBatch(declare({ metric: "M-03", start: 0, end: W }), s.receipt, { binding: BIND })).toMatchObject({ status: "pass", latency: { within: 29 } });
  });

  it("scores M-04 on authenticated/accepted sums and O-13 refs", () => {
    const disp = (accepted: number, others: number, extra?: (h: Harness) => void) => scenario((h) => {
      h.sink.emit("action_disposition_total", { bot_ref: BOT, route_type: "group", code: "admitted" }, accepted);
      h.sink.emit("action_disposition_total", { bot_ref: BOT, route_type: "group", code: "rejected" }, others);
      h.sink.emit("action_disposition_total", { bot_ref: BOT, route_type: "group", code: "unauthorized_binding" }, 50);
      h.sink.emit("session_expired_total", { bot_ref: BOT }, 50);
      extra?.(h);
    });
    const refs = [ART];
    const m04 = (s: ReturnType<typeof scenario>, withRefs = true) =>
      evaluateBatch(declare({ metric: "M-04", start: 0, end: W, ...(withRefs ? { storeOracleRefs: refs } : {}) }), s.receipt, { binding: BIND });
    expect(m04(disp(10, 20))).toMatchObject({ status: "pass", admission: { authenticated: 30, accepted: 10 } });
    expect(m04(disp(9, 21)).reasons).toEqual(["insufficient_samples"]);
    expect(m04(disp(10, 19)).reasons).toEqual(["insufficient_samples"]);
    expect(m04(disp(10, 20), false).reasons).toEqual(["missing_evidence"]);
    expect(m04(disp(10, 20, (h) => h.sink.emit("critical_signal_total", { capability: "interaction", code: "duplicate_admission" }, 1))).status).toBe("fail");
  });

  it("never passes an M-05 batch: the registry has no selected-output turn count", () => {
    const s = scenario(() => undefined);
    expect(evaluateBatch(declare({ metric: "M-05", start: 0, end: W }), s.receipt, { binding: BIND })).toMatchObject({ status: "invalid", reasons: ["insufficient_samples"] });
  });

  it("checks binding, drills, scope and declaration provenance", () => {
    const s = latency(Array(30).fill(5), (h) => {
      h.sink.emit("critical_signal_total", { capability: "display", code: "synthetic_drill" }, 1);
      h.sink.emit("stale_sequence_total", { bot_ref: "b" + "9".repeat(16), capability: "display" }, 1);
    });
    expect(m02(s).reasons).toEqual(["binding_missing", "drill_in_canary"]);
    expect(m02(s, { binding: { ...BIND, candidateSha: "f".repeat(40) } }).reasons).toContain("binding_mismatch");
    expect(evaluateBatch(declare({ metric: "M-02", start: 0, end: W, cohortRef: "other" }), s.receipt, { binding: BIND }).status).toBe("pending");
    const forged = { ...declare({ metric: "M-02", start: 0, end: W }) };
    expect(evaluateBatch(forged, s.receipt, { binding: BIND })).toMatchObject({ status: "invalid", reasons: ["undeclared_batch"] });
    expect(m02(latency(Array(30).fill(5)), { declarationReasons: ["overlapping_batch"] }).reasons).toEqual(["overlapping_batch"]);
  });
});

describe("batch chains and resume (§5.6)", () => {
  const d = (seq: number, metric = "M-02") => declare({ batchId: `b${seq}`, metric, sequence: seq, start: seq * W, end: (seq + 1) * W });
  const chain = (statuses: (string | undefined)[], metric = "M-02"): ChainEntry[] =>
    statuses.map((st, i) => ({
      declaration: d(i + 1, metric), ...(st === undefined ? {} : { status: st as never }),
      ...(st === "invalid" ? { reasons: ["telemetry_loss" as const] } : {}),
    }));
  const summary = (entries: ChainEntry[]) => batchSignals(entries).map((s) => `${s.batchId}:${s.action}:${s.reason}`);

  it("skips pending batches before either accumulator", () => {
    expect(summary(chain(["fail", "pending", "fail"]))).toEqual(["b3:pause_expansion:consecutive_fail"]);
    expect(summary(chain(["invalid", "pending", "invalid"]))).toEqual([
      "b1:block_expansion_until_rerun:telemetry_loss", "b3:block_expansion_until_rerun:telemetry_loss", "b3:pause_expansion:consecutive_invalid",
    ]);
  });

  it("bridges invalid batches in the valid-fail chain and resets on a valid pass", () => {
    expect(summary(chain(["fail", "invalid", "fail"]))).toEqual(["b2:block_expansion_until_rerun:telemetry_loss", "b3:pause_expansion:consecutive_fail"]);
    expect(summary(chain(["fail", "pass", "fail"]))).toEqual([]);
    expect(summary(chain(["invalid", "pass", "invalid"]))).toEqual(["b1:block_expansion_until_rerun:telemetry_loss", "b3:block_expansion_until_rerun:telemetry_loss"]);
    expect(summary(chain(["invalid", "invalid"], "M-03"))).toEqual(["b1:block_expansion_until_rerun:telemetry_loss", "b2:block_expansion_until_rerun:telemetry_loss"]);
    expect(summary(chain(["fail", "fail"], "M-04"))).toEqual([]);
  });

  it("fails closed for a declared batch without a status", () => {
    expect(summary(chain([undefined]))).toEqual(["b1:block_expansion_until_rerun:status_missing"]);
    expect(batchSignals(chain([undefined], "M-05"))[0].scope).toEqual({ kind: "cohort", cohortRef: COH, capabilities: ["automatic", "display", "interaction"] });
  });

  it("allows resume only after revalidation plus a fresh valid pass", () => {
    const entries = chain(["invalid", "pass"]);
    const block = batchSignals(entries)[0];
    expect(resumeAllowed(entries, block, "comment:XIN-2201#4e439455-934e-43d7-bf8d-972ecae90583")).toBe(true);
    expect(resumeAllowed(entries, block, "rerun please")).toBe(false);
    expect(resumeAllowed(chain(["invalid", "fail"]), block, ART)).toBe(false);
  });
});

describe("M-01 (§5.2)", () => {
  const utc = "2026-10-15T07:40:34.000Z";
  const record = (subId: string, level: string, result = "pass", extra: Record<string, unknown> = {}) => JSON.stringify({
    subId, level, candidateSha: SHA, frozenBaselineSha: BASE_SHA, ...RT, apiOrigin: ORIGIN, profileHash: PROFILE, botRef: BOT,
    channelRef: "c" + "1".repeat(16), routeType: "dm", startUtc: utc, endUtc: utc, fixtureRevision: "fx@v1", harnessIdentity: "h@1.0.0", result, ...extra,
  });
  const attestation = (subId: string, level: string, result = "pass", runtime: { codexSdkVersion: string; codexCliVersion: string; nodeVersion: string } = RT) => JSON.stringify({
    subId, level, candidateSha: SHA, frozenBaselineSha: BASE_SHA, ...runtime, suiteRef: "artifact:suite@sha256:" + "d".repeat(64),
    startUtc: utc, endUtc: utc, harnessIdentity: "h@1.0.0", fixtureRevision: "fx@v1", result,
  });
  const p0 = ACCEPTANCE_SUBIDS_V1.filter((r) => r.priority === "P0");
  const recordable = p0.filter((r) => ["live_api", "deployment", "black_box"].includes(r.declaredLevel));
  const attestable = p0.filter((r) => !recordable.includes(r));
  const full = () => ({ evidence: recordable.map((r) => record(r.subId, r.declaredLevel)), attestations: attestable.map((r) => attestation(r.subId, r.declaredLevel)) });
  const receiptWith = (fill?: (h: Harness) => void) => scenario((h) => fill?.(h)).receipt;

  it("passes only with every P0 row, deployment and binding coverage", () => {
    expect(recordable).toHaveLength(28);
    expect(attestable).toHaveLength(66);
    const r = evaluateM01({ ...full(), binding: BIND, receipt: receiptWith() });
    expect(r.status).toBe("pass");
    expect(r.rows).toHaveLength(94);
    expect(r.rejected).toEqual([]);
    expect(validateEvidenceRecord(full().evidence[0], BIND).ok && validateSourceAttestation(full().attestations[0], BIND).ok).toBe(true);
  });

  it("is unverified without AC-011.10, a deployment or binding coverage", () => {
    const f = full();
    const noAc = evaluateM01({ ...f, attestations: f.attestations.filter((a) => !a.includes("AC-011.10")), binding: BIND, receipt: receiptWith() });
    expect(noAc.status).toBe("unverified");
    expect(noAc.rows.find((x) => x.subId === "AC-011.10")!.verdict).toBe("unverified");
    expect(evaluateM01({ ...f, binding: BIND }).reasons).toEqual(["missing_environment_evidence"]);
    const uncovered = { ...BIND, sourceRuntimes: [RT], environments: new Map([[BOT, { runtime: { ...RT, nodeVersion: "v24.0.0" }, apiOrigin: ORIGIN, profileHash: PROFILE }]]) };
    expect(evaluateM01({ ...f, binding: uncovered, receipt: receiptWith() }).status).toBe("unverified");
  });

  it("applies the per-row precedence and per-runtime attestation rule", () => {
    const f = full();
    const na = record("AC-023.2", "live_api", "n/a", { rationale: "Owner-approved disabled scope", ownerApprovalRef: "comment:XIN-2038#2e0ef55a-b5a4-42e8-9f03-52e26d95e292" });
    const withNa = { ...f, evidence: f.evidence.filter((e) => !e.includes('"AC-023.2"')).concat([na]) };
    expect(evaluateM01({ ...withNa, binding: BIND, receipt: receiptWith() })).toMatchObject({ status: "pass" });
    expect(evaluateM01({ ...f, evidence: f.evidence.concat([na]), binding: BIND, receipt: receiptWith() }).rows.find((x) => x.subId === "AC-023.2")!.verdict).toBe("unverified");
    expect(evaluateM01({ ...f, evidence: f.evidence.concat([record("AC-023.2", "live_api", "fail")]), binding: BIND, receipt: receiptWith() }).status).toBe("fail");
    const rt2 = { ...RT, nodeVersion: "v24.1.0" };
    const twoRuntimes = { ...BIND, sourceRuntimes: [RT, rt2] };
    expect(evaluateM01({ ...f, binding: twoRuntimes, receipt: receiptWith() }).status).toBe("unverified");
    const both = { ...f, attestations: f.attestations.concat(attestable.map((r) => attestation(r.subId, r.declaredLevel, "pass", rt2))) };
    expect(evaluateM01({ ...both, binding: twoRuntimes, receipt: receiptWith() }).status).toBe("pass");
    const otherSha = record("AC-023.2", "live_api").replace(SHA, "f".repeat(40));
    const r = evaluateM01({ ...f, evidence: f.evidence.filter((e) => !e.includes('"AC-023.2"')).concat([otherSha]), binding: BIND, receipt: receiptWith() });
    expect(r.status).toBe("unverified");
    expect(r.rejected[0].diagnostics).toEqual([{ path: "/candidateSha", rule: "binding_mismatch" }]);
  });

  it("never passes from a receipt carrying identity, history, binding or completeness faults", () => {
    const h = running(0);
    const live = [rec("s1", [li(h, 0, 0, "running", 1)])];
    const m01 = (receipt: EvaluationReceipt, binding = BIND) => evaluateM01({ ...full(), binding, receipt });
    expect(m01(openFor(h.lines, live, dep({ s1: [0] }))).status).toBe("pass");
    const uncoveredSlot = m01(openFor(h.lines, live, dep({ s1: [0], s2: [0] })));
    expect(uncoveredSlot.status).toBe("unverified");
    expect(uncoveredSlot.reasons).toContain("missing_liveness_evidence");
    const stopped = healthy(0, 300_000);
    const noStop = m01(openFor(stopped.lines, [rec("s1", [li(stopped, 0, 300_000, "clean", 1)])], dep({ s1: [0] })));
    expect(noStop.status).toBe("unverified");
    expect(noStop.reasons).toContain("missing_liveness_evidence");
    const otherCohort = m01(openFor(h.lines, [rec("s1", [li(h, 0, 0, "running", 1)], "b1", "other")], dep({ s1: [0] })));
    expect(otherCohort.reasons).toContain("liveness_identity_mismatch");
    expect(otherCohort.status).toBe("unverified");
    const otherCandidate = m01(openFor(h.lines, live, dep({ s1: [0] }, COH, "f".repeat(40))));
    expect(otherCandidate).toMatchObject({ status: "unverified" });
    expect(otherCandidate.reasons).toContain("binding_mismatch");
    const underived = m01(openFor(h.lines, live, dep({ s1: [0] }), 3_000_000, { origins: [O] }));
    expect(underived.status).toBe("unverified");
    expect(underived.reasons).toContain("binding_mismatch");
    const foreign = m01(openFor(h.lines, live, dep({ s1: [0] }), 3_000_000, { origins: [O, O2, "o" + "9".repeat(16)] }));
    expect(foreign.reasons).toContain("binding_mismatch");
    const noRuntimes = m01(openFor(h.lines, live, dep({ s1: [0] })), { ...BIND, sourceRuntimes: [] });
    expect(noRuntimes.status).toBe("unverified");
    expect(noRuntimes.reasons).toContain("binding_missing");
  });

  it("requires an environment for every Bot and complete telemetry over the O-12 period", () => {
    const strange = scenario((h) => h.sink.emit("stale_sequence_total", { bot_ref: "b" + "9".repeat(16), capability: "display" }, 1));
    const unbound = evaluateM01({ ...full(), binding: BIND, receipt: strange.receipt });
    expect(unbound.status).toBe("unverified");
    expect(unbound.reasons).toContain("binding_missing");
    const torn = scenario(() => undefined);
    const quarantined = evaluateM01({ ...full(), binding: BIND, receipt: openFor([...torn.h.lines, "[cards-metric] {"], torn.live, torn.D) });
    expect(quarantined.status).toBe("unverified");
    expect(quarantined.reasons).toContain("telemetry_loss");
    const gap = harness(0);
    gap.at(200_000);
    gap.sink.heartbeat();
    gap.beats(3_000_000);
    const lossy = evaluateM01({ ...full(), binding: BIND, receipt: openFor(gap.lines, [rec("s1", [li(gap, 0, 0, "running", 1)])], dep({ s1: [0] })) });
    expect(lossy.status).toBe("unverified");
    expect(lossy.reasons).toContain("telemetry_loss");
  });

  it("applies the same binding-origin derivation to batches", () => {
    const s = scenario((h) => { for (let i = 0; i < 30; i++) h.sink.emit("first_frame_ms", FF, 5); });
    expect(evaluateBatch(declare({ metric: "M-02", start: 0, end: W }), s.receipt, { binding: BIND }).status).toBe("pass");
    const underived = openFor(s.h.lines, s.live, s.D, 3_000_000, { origins: [O] });
    expect(evaluateBatch(declare({ metric: "M-02", start: 0, end: W }), underived, { binding: BIND }).reasons).toEqual(["binding_mismatch"]);
    expect(evaluateBatch(declare({ metric: "M-02", start: 0, end: W }), s.receipt, { binding: { ...BIND, sourceRuntimes: [] } }).reasons).toEqual(["binding_missing"]);
  });

  it("fails on any M-01 critical code in the O-12 period, excluding drills and halts", () => {
    const crit = receiptWith((h) => h.sink.emit("critical_signal_total", { capability: "display", code: "cross_bot_route_leak" }, 1));
    expect(evaluateM01({ ...full(), binding: BIND, receipt: crit })).toMatchObject({ status: "fail", reasons: ["cross_bot_route_leak"] });
    const drill = receiptWith((h) => {
      h.sink.emit("critical_signal_total", { capability: "display", code: "synthetic_drill" }, 1);
      h.sink.emit("critical_signal_total", { capability: "display", code: "event_stream_halt" }, 1);
    });
    expect(evaluateM01({ ...full(), binding: BIND, receipt: drill }).status).toBe("pass");
  });
});
