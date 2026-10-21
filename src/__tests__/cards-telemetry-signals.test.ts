import { describe, expect, it } from "vitest";
import {
  actionSignalValid, batchSignals, openEvaluation, resumeAllowed, parseCollection, windowEvaluation,
  type ActionSignal, type ChainEntry,
} from "../cards/telemetry.js";
import {
  B, BOT, COH, K, O, W, declare, dep, harness, iso, li, openFor, rec, type Harness,
} from "./fixtures/telemetry-harness.js";

const AT = iso(W);

// ─── Compile-time contract (checked by the strict new-test type check) ─────
const required: ActionSignal = {
  action: "pause_expansion", metric: "M-03", source: "observed", atUtc: AT, reason: "window_threshold_pause",
  scope: { kind: "cohort", cohortRef: COH, capabilities: ["automatic"] },
};
// @ts-expect-error reason is required on every action signal
const missingReason: ActionSignal = {
  action: "pause_expansion", metric: "M-03", source: "observed", atUtc: AT,
  scope: { kind: "cohort", cohortRef: COH, capabilities: ["automatic"] },
};
const unknownReason: ActionSignal = {
  action: "pause_expansion", metric: "M-05", source: "observed", atUtc: AT,
  // @ts-expect-error reason is a closed union
  reason: "threshold", scope: { kind: "origin", originRef: O },
};

function scenario(fill: (h: Harness) => void, until = 3_000_000) {
  const h = harness(0);
  h.beats(60_000);
  fill(h);
  h.beats(until);
  const live = [rec("s1", [li(h, 0, 0, "running", 1)])];
  return openFor(h.lines, live, dep({ s1: [0] }), until);
}
const sliceAll = (h: Harness, s: number, e: number) => {
  for (let t = s; t < e; t += 60_000) {
    h.beats(Math.min(t + 60_000, e));
    h.sink.emitInterval("cooldown_slice_ms", { origin_ref: O, code: "client_backoff" }, 1000.5 + t, 1000.5 + Math.min(t + 60_000, e));
  }
};

describe("closed ActionSignal reason mapping (v16-B)", () => {
  it("keeps reason required and closed at compile time", () => {
    expect(actionSignalValid(required)).toBe(true);
    expect(actionSignalValid(missingReason)).toBe(false);
    expect(actionSignalValid(unknownReason)).toBe(false);
  });

  it("maps every ordinary window threshold pause to window_threshold_pause", () => {
    const receipt = scenario((h) => {
      h.sink.emit("unreconciled_send_aged_total", { bot_ref: BOT, capability: "automatic" }, 3);
      h.sink.emit("closure_edit_failed_total", { bot_ref: BOT, capability: "interaction", code: "gone" }, 3);
      h.sink.emit("action_disposition_total", { bot_ref: BOT, route_type: "group", code: "dead_letter" }, 2);
      h.sink.emit("unresolved_claim_aged_total", { bot_ref: BOT }, 1);
    });
    const w = windowEvaluation(K, receipt);
    expect(w.completeness).toBe("complete");
    expect(w.signals.map((s) => [s.metric, s.action, s.reason])).toEqual([
      ["M-03", "pause_expansion", "window_threshold_pause"],
      ["M-03", "pause_expansion", "window_threshold_pause"],
      ["M-04", "pause_expansion", "window_threshold_pause"],
    ]);
    for (const s of w.signals) expect(actionSignalValid(s)).toBe(true);
  });

  it("maps M-05 cooldown pauses to cooldown_pause", () => {
    const h = harness(0);
    sliceAll(h, 0, 300_000);
    h.beats(3_000_000);
    const w = windowEvaluation(K, openFor(h.lines, [rec("s1", [li(h, 0, 0, "running", 1)])], dep({ s1: [0] })));
    const pauses = w.signals.filter((s) => s.metric === "M-05");
    expect(pauses).toEqual([{ action: "pause_expansion", metric: "M-05", source: "observed", atUtc: AT, reason: "cooldown_pause", scope: { kind: "origin", originRef: O } }]);
    expect(actionSignalValid(pauses[0])).toBe(true);
  });

  it("keeps an applicable existing reason on incomplete-window blocks", () => {
    const h = harness(0);
    h.at(200_000);
    h.sink.heartbeat();
    h.beats(3_000_000);
    const w = windowEvaluation(K, openFor(h.lines, [rec("s1", [li(h, 0, 0, "running", 1)])], dep({ s1: [0] })));
    expect(w.completeness).toBe("incomplete");
    const block = w.signals.find((s) => s.action === "block_expansion_until_rerun")!;
    expect(block).toMatchObject({ metric: "completeness", reason: "telemetry_loss" });
    expect(actionSignalValid(block)).toBe(true);
    const unclean = harness(0);
    unclean.beats(300_000);
    const u = windowEvaluation(K, openFor(unclean.lines, [rec("s1", [li(unclean, 0, 300_000, "unclean", 1)])], dep({ s1: [0, 300_000] })));
    const ub = u.signals.find((s) => s.action === "block_expansion_until_rerun")!;
    expect(["incarnation_unclean", "telemetry_loss"]).toContain(ub.reason);
    expect(actionSignalValid(ub)).toBe(true);
  });

  it("keeps critical reason codes immediate while the window is pending", () => {
    const h = harness(0);
    h.at(10_000);
    h.sink.emit("critical_signal_total", { capability: "display", code: "protected_token" }, 1);
    h.sink.emit("critical_signal_total", { bot_ref: BOT, capability: "interaction", code: "unauthorized_admission" }, 1);
    h.sink.emit("critical_signal_total", { capability: "automatic", code: "output_parity_mismatch" }, 1);
    h.sink.emit("unreconciled_send_aged_total", { bot_ref: BOT, capability: "automatic" }, 5);
    const pendingReceipt = openFor(h.lines, [rec("s1", [li(h, 0, 0, "running", 1)])], dep({ s1: [0] }), 20_000);
    const w = windowEvaluation(K, pendingReceipt);
    expect(w.completeness).toBe("pending");
    expect(w.signals.map((s) => [s.metric, s.reason])).toEqual([
      ["M-01", "protected_token"], ["M-04", "unauthorized_admission"], ["M-05", "output_parity_mismatch"],
    ]);
    for (const s of w.signals) expect(actionSignalValid(s)).toBe(true);
    const invalid = openEvaluation({ collection: parseCollection(h.lines), liveness: [], deployment: null, cohortRef: COH, livenessBatchId: "b1", evalUtc: B + 20_000, origins: [O] });
    expect(windowEvaluation(K, invalid).signals.map((s) => s.reason)).toEqual(["protected_token", "unauthorized_admission", "output_parity_mismatch"]);
  });

  it("carries existing reasons on every batch-chain signal", () => {
    const d = (seq: number, metric = "M-02") => declare({ batchId: `b${seq}`, metric, sequence: seq, start: seq * W, end: (seq + 1) * W });
    const entries: ChainEntry[] = [
      { declaration: d(1), status: "invalid", reasons: ["insufficient_samples", "telemetry_loss"] },
      { declaration: d(2), status: "invalid", reasons: ["drill_in_canary"] },
      { declaration: d(3) },
      { declaration: d(4), status: "fail" },
      { declaration: d(5), status: "fail" },
      { declaration: d(6), status: "invalid" },
    ];
    const sig = batchSignals(entries);
    expect(sig.map((s) => `${s.batchId}:${s.action}:${s.reason}`)).toEqual([
      "b1:block_expansion_until_rerun:insufficient_samples",
      "b2:block_expansion_until_rerun:drill_in_canary",
      "b2:pause_expansion:consecutive_invalid",
      "b3:block_expansion_until_rerun:status_missing",
      "b3:pause_expansion:consecutive_invalid",
      "b5:pause_expansion:consecutive_fail",
      "b6:block_expansion_until_rerun:status_missing",
    ]);
    for (const s of sig) expect([s.batchId, actionSignalValid(s)]).toEqual([s.batchId, true]);
  });

  it("grants resume only for a valid signal whose metric and cohort match its bound declaration", () => {
    const d = (seq: number) => declare({ batchId: `r${seq}`, metric: "M-02", sequence: seq, start: seq * W, end: (seq + 1) * W });
    const entries: ChainEntry[] = [
      { declaration: d(1), status: "invalid", reasons: ["telemetry_loss"] },
      { declaration: d(2), status: "pass" },
    ];
    const block = batchSignals(entries)[0];
    const ref = "comment:XIN-2201#4e439455-934e-43d7-bf8d-972ecae90583";
    expect(actionSignalValid(block)).toBe(true);
    expect(resumeAllowed(entries, block, ref)).toBe(true);
    const forged = (patch: Record<string, unknown>) => ({ ...block, ...patch }) as unknown as ActionSignal;
    expect(resumeAllowed(entries, forged({ reason: "threshold" }), ref)).toBe(false);
    expect(resumeAllowed(entries, forged({ reason: "cooldown_pause" }), ref)).toBe(false);
    expect(resumeAllowed(entries, forged({ reason: undefined }), ref)).toBe(false);
    expect(resumeAllowed(entries, forged({ action: "disable_capability" }), ref)).toBe(false);
    const otherMetric = forged({ metric: "M-03", scope: { kind: "cohort", cohortRef: COH, capabilities: ["automatic", "interaction"] } });
    expect(actionSignalValid(otherMetric)).toBe(true);
    expect(resumeAllowed(entries, otherMetric, ref)).toBe(false);
    const otherCohort = forged({ scope: { kind: "cohort", cohortRef: "other", capabilities: ["automatic"] } });
    expect(actionSignalValid(otherCohort)).toBe(true);
    expect(resumeAllowed(entries, otherCohort, ref)).toBe(false);
    expect(resumeAllowed(entries, null as never, ref)).toBe(false);
  });

  it("fails closed for unknown or incompatible reason/action/metric/scope combinations", () => {
    const origin = { kind: "origin" as const, originRef: O };
    const coh = (capabilities: string[]) => ({ kind: "cohort" as const, cohortRef: COH, capabilities });
    const cap = (capability: string, botRef?: string) => ({ kind: "capability" as const, capability, ...(botRef ? { botRef } : {}) });
    const base = { source: "observed", atUtc: AT };
    const good: Record<string, unknown>[] = [
      { ...base, action: "pause_expansion", metric: "M-05", reason: "cooldown_pause", scope: origin },
      { ...base, action: "pause_expansion", metric: "M-03", reason: "window_threshold_pause", scope: coh(["automatic", "display"]) },
      { ...base, action: "pause_expansion", metric: "M-04", reason: "window_threshold_pause", scope: coh(["interaction"]) },
      { ...base, action: "disable_capability", metric: "M-01", reason: "cross_bot_route_leak", scope: cap("display", BOT) },
      { ...base, action: "disable_capability", metric: "M-04", reason: "duplicate_admission", scope: cap("interaction") },
      { ...base, action: "disable_capability", metric: "M-05", reason: "card_lost_final", scope: cap("automatic") },
      { ...base, action: "block_expansion_until_rerun", metric: "completeness", reason: "telemetry_loss", scope: coh(["automatic", "display", "interaction"]) },
      { ...base, action: "block_expansion_until_rerun", metric: "M-02", reason: "status_missing", scope: coh(["automatic"]), batchId: "b1" },
      { ...base, action: "pause_expansion", metric: "M-02", reason: "consecutive_invalid", scope: coh(["automatic"]), batchId: "b1" },
      { ...base, action: "pause_expansion", metric: "M-03", reason: "consecutive_fail", scope: coh(["automatic", "interaction"]), batchId: "b1" },
    ];
    for (const s of good) expect([s, actionSignalValid(s)]).toEqual([s, true]);
    const bad: Record<string, unknown>[] = [
      { ...good[0], reason: undefined },
      { ...good[0], reason: "threshold" },
      { ...good[0], reason: "window_threshold_pause" },
      { ...good[1], reason: "cooldown_pause" },
      { ...good[1], metric: "M-02" },
      { ...good[1], metric: "M-05" },
      { ...good[2], scope: coh(["automatic"]) },
      { ...good[3], reason: "window_threshold_pause" },
      { ...good[3], reason: "card_lost_final" },
      { ...good[3], reason: "synthetic_drill" },
      { ...good[3], reason: "event_stream_halt" },
      { ...good[4], scope: cap("display") },
      { ...good[5], action: "pause_expansion" },
      { ...good[6], reason: "consecutive_fail" },
      { ...good[6], reason: "cooldown_pause" },
      { ...good[6], scope: coh(["automatic"]) },
      { ...good[7], batchId: undefined },
      { ...good[8], metric: "M-03", scope: coh(["automatic", "interaction"]) },
      { ...good[9], reason: "window_threshold_pause" },
      { ...good[0], atUtc: "yesterday" },
      { ...good[0], source: "drill" },
      { ...good[0], extra: true },
      { ...good[0], scope: { kind: "origin", originRef: "https://api.example.com" } },
      { ...good[1], batchId: "b1" },
    ];
    for (const s of bad) expect([s, actionSignalValid(s)]).toEqual([s, false]);
    expect(actionSignalValid(null)).toBe(false);
    expect(actionSignalValid("pause_expansion")).toBe(false);
  });
});
