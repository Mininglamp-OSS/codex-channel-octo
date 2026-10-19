import { describe, expect, it } from "vitest";
import {
  createTelemetrySink, evaluateBatch, evaluateM01, inspectEvaluation, parseCollection, windowEvaluation,
  type WindowEvaluation,
} from "../cards/telemetry.js";
import { ART, B, BIND, BOT, BOT2, K, W, declare, dep, iso, openFor, rec } from "./fixtures/telemetry-harness.js";

type Labels = Record<string, string>;

/**
 * A real sink whose writer accepts the armed line and then throws. The sink does not consume the sequence
 * number for a throwing write, so the next flushed `telemetry_loss_total` reuses it.
 */
function acceptThenThrow() {
  const h = { t: 0, lines: [] as string[], armed: false };
  const sink = createTelemetrySink({
    wall: { nowUtcMs: () => B + h.t },
    mono: { nowMono: () => 1000.5 + h.t },
    write: (l) => {
      h.lines.push(l.endsWith("\n") ? l.slice(0, -1) : l);
      if (h.armed) { h.armed = false; throw new Error("writer failure after accept"); }
    },
  });
  const beats = (t: number): void => {
    while (h.t + 60_000 <= t) { h.t += 60_000; sink.heartbeat(); }
    h.t = t;
  };
  const at = (t: number): void => { h.t = t; };
  const live = () => [rec("s1", [{ inc: sink.inc, startUtc: iso(0), exit: "running", ordinal: 1 }])];
  return { h, sink, beats, at, live };
}

/** Critical emitted at 70 s through an accept-then-throw write; the 120 s heartbeat flushes the loss with the reused seq. */
function lossAfterCritical(labels: Labels, until = 3_000_000) {
  const s = acceptThenThrow();
  s.beats(60_000);
  s.at(70_000);
  s.h.armed = true;
  expect(s.sink.emit("critical_signal_total", labels, 1)).toBe("sink_failed");
  s.beats(until);
  return { ...s, lines: s.h.lines };
}

const parsed = (lines: string[]) => parseCollection(lines).lines;
const lineOf = (lines: string[], name: string, code?: string): string =>
  lines.find((l) => l.includes(`"name":"${name}"`) && (code === undefined || l.includes(`"code":"${code}"`)))!;
const relabel = (line: string, from: string, to: string): string => {
  const out = line.replace(from, to);
  expect(out).not.toBe(line);
  return out;
};
const sortJson = (xs: readonly unknown[]): string[] => xs.map((x) => JSON.stringify(x)).sort();
const observations = (w: WindowEvaluation) => ({
  signals: sortJson(w.signals.filter((s) => s.action === "disable_capability")),
  drills: sortJson(w.drills),
  runtime: sortJson(w.runtimeSignals),
});
const disables = (w: WindowEvaluation) =>
  w.signals.filter((s) => s.action === "disable_capability").map((s) => [s.metric, s.reason, s.scope]);
const D = dep({ s1: [0] });
const PT = { capability: "display", code: "protected_token" };

describe("critical observations survive a reused sequence (accept-then-throw)", () => {
  it("keeps the M-01 disable after the sink flushes telemetry_loss_total with the same seq", () => {
    const { lines, live } = lossAfterCritical(PT);
    const crit = parsed(lines).find((o) => o.name === "critical_signal_total")!;
    const loss = parsed(lines).find((o) => o.name === "telemetry_loss_total")!;
    expect(loss).toMatchObject({ inc: crit.inc, seq: crit.seq, labels: { code: "sink_failed" } });
    const r = openFor(lines, live(), D);
    expect(inspectEvaluation(r)!.quarantined).toBe(true);
    const w = windowEvaluation(K, r);
    expect(w.completeness).toBe("incomplete");
    expect(disables(w)).toEqual([["M-01", "protected_token", { kind: "capability", capability: "display" }]]);
    expect(w.signals.find((s) => s.action === "disable_capability")!.atUtc).toBe(iso(70_000));
  });

  it("keeps M-04 and M-05 disables and the event_stream_halt runtime signal despite the loss", () => {
    const m04 = lossAfterCritical({ bot_ref: BOT, capability: "display", code: "duplicate_admission" });
    expect(disables(windowEvaluation(K, openFor(m04.lines, m04.live(), D))))
      .toEqual([["M-04", "duplicate_admission", { kind: "capability", capability: "interaction", botRef: BOT }]]);
    const m05 = lossAfterCritical({ capability: "automatic", code: "card_lost_final" });
    expect(disables(windowEvaluation(K, openFor(m05.lines, m05.live(), D))))
      .toEqual([["M-05", "card_lost_final", { kind: "capability", capability: "automatic" }]]);
    const halt = lossAfterCritical({ capability: "display", code: "event_stream_halt" });
    expect(windowEvaluation(K, openFor(halt.lines, halt.live(), D)).runtimeSignals).toEqual([{ code: "event_stream_halt", atUtc: iso(70_000) }]);
  });

  it("fails M-01 on the critical code despite the reused-seq loss", () => {
    const { lines, live } = lossAfterCritical(PT);
    const m01 = evaluateM01({ evidence: [], attestations: [], binding: BIND, receipt: openFor(lines, live(), D) });
    expect(m01.reasons).toContain("protected_token");
    expect(m01.status).toBe("fail");
  });

  it("still returns the disable while the window is pending on the horizon", () => {
    const { lines, live } = lossAfterCritical(PT, 130_000);
    const w = windowEvaluation(K, openFor(lines, live(), D, 130_000));
    expect(w.completeness).toBe("pending");
    expect(disables(w)).toEqual([["M-01", "protected_token", { kind: "capability", capability: "display" }]]);
  });

  it("still returns the disable when a parse fault quarantines the collection", () => {
    const { lines, live } = lossAfterCritical(PT);
    const r = openFor([...lines, "[cards-metric] {torn"], live(), D);
    expect(parseCollection([...lines, "[cards-metric] {torn"]).parseFault).toBe(true);
    expect(inspectEvaluation(r)!.quarantined).toBe(true);
    expect(disables(windowEvaluation(K, r))).toEqual([["M-01", "protected_token", { kind: "capability", capability: "display" }]]);
  });
});

describe("critical observations are independent of same-seq order", () => {
  it("yields the same observations for critical/loss in either order", () => {
    const { lines, live } = lossAfterCritical(PT);
    const crit = lineOf(lines, "critical_signal_total");
    const loss = lineOf(lines, "telemetry_loss_total");
    const rest = lines.filter((l) => l !== crit && l !== loss);
    const a = windowEvaluation(K, openFor([...rest, crit, loss], live(), D));
    const b = windowEvaluation(K, openFor([...rest, loss, crit], live(), D));
    expect(observations(a)).toEqual(observations(b));
    expect(observations(a).signals).toHaveLength(1);
  });

  it("yields both the critical disable and the drill for critical/drill in either order", () => {
    const { lines, live } = lossAfterCritical(PT);
    const crit = lineOf(lines, "critical_signal_total");
    const drill = relabel(crit, '"code":"protected_token"', '"code":"synthetic_drill"');
    const rest = lines.filter((l) => l !== crit);
    const a = windowEvaluation(K, openFor([...rest, crit, drill], live(), D));
    const b = windowEvaluation(K, openFor([...rest, drill, crit], live(), D));
    expect(observations(a)).toEqual(observations(b));
    expect(disables(a)).toEqual([["M-01", "protected_token", { kind: "capability", capability: "display" }]]);
    expect(a.drills).toEqual([{ action: "disable_capability", source: "drill", atUtc: iso(70_000), reason: "synthetic_drill", scope: { kind: "capability", capability: "display" } }]);
  });

  it("retains distinct critical records sharing a sequence (code, capability, time, bot)", () => {
    const { lines, live } = lossAfterCritical({ bot_ref: BOT, capability: "display", code: "protected_token" });
    const crit = lineOf(lines, "critical_signal_total");
    const variants = [
      relabel(crit, '"code":"protected_token"', '"code":"cross_bot_route_leak"'),
      relabel(crit, '"capability":"display"', '"capability":"automatic"'),
      relabel(crit, iso(70_000), iso(70_001)),
      relabel(crit, BOT, BOT2),
    ];
    const forward = windowEvaluation(K, openFor([...lines, ...variants], live(), D));
    const backward = windowEvaluation(K, openFor([...variants].reverse().concat([...lines].reverse()), live(), D));
    expect(observations(forward)).toEqual(observations(backward));
    expect(sortJson(disables(forward))).toEqual(sortJson([
      ["M-01", "protected_token", { kind: "capability", capability: "display", botRef: BOT }],
      ["M-01", "cross_bot_route_leak", { kind: "capability", capability: "display", botRef: BOT }],
      ["M-01", "protected_token", { kind: "capability", capability: "automatic", botRef: BOT }],
      ["M-01", "protected_token", { kind: "capability", capability: "display", botRef: BOT }],
      ["M-01", "protected_token", { kind: "capability", capability: "display", botRef: BOT2 }],
    ]));
    expect(forward.signals.filter((s) => s.action === "disable_capability").map((s) => s.atUtc).sort())
      .toEqual([iso(70_000), iso(70_000), iso(70_000), iso(70_000), iso(70_001)]);
  });
});

describe("identical transport duplicates", () => {
  it("retain a single observed, drill and runtime signal", () => {
    const s = acceptThenThrow();
    s.beats(60_000);
    s.at(70_000);
    s.sink.emit("critical_signal_total", PT, 1);
    s.sink.emit("critical_signal_total", { capability: "display", code: "synthetic_drill" }, 1);
    s.sink.emit("critical_signal_total", { capability: "display", code: "event_stream_halt" }, 1);
    s.beats(3_000_000);
    const crit = s.h.lines.filter((l) => l.includes('"name":"critical_signal_total"'));
    expect(crit).toHaveLength(3);
    const r = openFor([...s.h.lines, ...crit, ...crit], s.live(), D);
    expect(inspectEvaluation(r)!.quarantined).toBe(false);
    const w = windowEvaluation(K, r);
    expect(w.completeness).toBe("complete");
    expect(disables(w)).toEqual([["M-01", "protected_token", { kind: "capability", capability: "display" }]]);
    expect(w.drills).toHaveLength(1);
    expect(w.runtimeSignals).toEqual([{ code: "event_stream_halt", atUtc: iso(70_000) }]);

    // The same record with a reordered label object (the completeness pass still treats differing bytes as a
    // conflicting seq and quarantines) yields one observation, not two.
    const reordered = relabel(crit[0], '{"capability":"display","code":"protected_token","level":"critical"}',
      '{"level":"critical","code":"protected_token","capability":"display"}');
    const rr = openFor([...s.h.lines, reordered], s.live(), D);
    expect(inspectEvaluation(rr)!.quarantined).toBe(true);
    expect(disables(windowEvaluation(K, rr))).toEqual([["M-01", "protected_token", { kind: "capability", capability: "display" }]]);
  });

  it("collapse around a reused-seq loss without duplicating the disable", () => {
    const { lines, live } = lossAfterCritical(PT);
    const crit = lineOf(lines, "critical_signal_total");
    const loss = lineOf(lines, "telemetry_loss_total");
    const w = windowEvaluation(K, openFor([...lines, crit, loss, crit], live(), D));
    expect(disables(w)).toEqual([["M-01", "protected_token", { kind: "capability", capability: "display" }]]);
  });

  it("do not inflate window counters across the M-03 threshold", () => {
    const s = acceptThenThrow();
    s.beats(60_000);
    s.at(70_000);
    s.sink.emit("closure_edit_failed_total", { bot_ref: BOT, capability: "interaction", code: "gone" }, 1);
    s.at(80_000);
    s.sink.emit("closure_edit_failed_total", { bot_ref: BOT, capability: "interaction", code: "gone" }, 1);
    s.beats(3_000_000);
    const fails = s.h.lines.filter((l) => l.includes('"name":"closure_edit_failed_total"'));
    expect(fails).toHaveLength(2);
    const w = windowEvaluation(K, openFor([...s.h.lines, ...fails, ...fails], s.live(), D));
    expect(w.completeness).toBe("complete");
    expect(w.signals).toEqual([]);
    const third = acceptThenThrow();
    third.beats(60_000);
    for (const t of [70_000, 80_000, 90_000]) {
      third.at(t);
      third.sink.emit("closure_edit_failed_total", { bot_ref: BOT, capability: "interaction", code: "gone" }, 1);
    }
    third.beats(3_000_000);
    expect(windowEvaluation(K, openFor(third.h.lines, third.live(), D)).signals.map((x) => [x.metric, x.reason]))
      .toEqual([["M-03", "window_threshold_pause"]]);
  });

  it("do not inflate batch admission counts and keep the M-04 critical fail", () => {
    const s = acceptThenThrow();
    s.beats(60_000);
    s.at(70_000);
    s.sink.emit("action_disposition_total", { bot_ref: BOT, route_type: "group", code: "admitted" }, 9);
    s.sink.emit("action_disposition_total", { bot_ref: BOT, route_type: "group", code: "rejected" }, 20);
    s.beats(3_000_000);
    const disp = s.h.lines.filter((l) => l.includes('"name":"action_disposition_total"'));
    const m04 = (lines: string[]) =>
      evaluateBatch(declare({ metric: "M-04", start: 0, end: W, storeOracleRefs: [ART] }), openFor(lines, s.live(), D), { binding: BIND });
    expect(m04([...s.h.lines, ...disp, ...disp])).toMatchObject({ reasons: ["insufficient_samples"], admission: { authenticated: 29, accepted: 9 } });

    const c = acceptThenThrow();
    c.beats(60_000);
    c.at(70_000);
    c.sink.emit("action_disposition_total", { bot_ref: BOT, route_type: "group", code: "admitted" }, 10);
    c.sink.emit("action_disposition_total", { bot_ref: BOT, route_type: "group", code: "rejected" }, 20);
    c.sink.emit("critical_signal_total", { capability: "interaction", code: "duplicate_admission" }, 1);
    c.beats(3_000_000);
    const crit = lineOf(c.h.lines, "critical_signal_total");
    const r = openFor([...c.h.lines, crit, crit], c.live(), D);
    const batch = evaluateBatch(declare({ metric: "M-04", start: 0, end: W, storeOracleRefs: [ART] }), r, { binding: BIND });
    expect(batch).toMatchObject({ status: "fail", reasons: [], admission: { authenticated: 30, accepted: 10 } });
  });
});
