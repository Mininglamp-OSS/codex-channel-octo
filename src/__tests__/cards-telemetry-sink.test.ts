import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TelemetryConfigError, createTelemetrySink, parseCollection } from "../cards/telemetry.js";
import { B, BOT, O, harness } from "./fixtures/telemetry-harness.js";

// Test-only observation of the sink's entropy source; the real generator runs unless a test overrides one call.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

const body = (line: string): Record<string, unknown> => JSON.parse(line.slice("[cards-metric] ".length)) as Record<string, unknown>;
const names = (lines: string[]): string[] => lines.map((l) => String(body(l).name));
const CAP = { bot_ref: BOT, capability: "automatic", code: "enabled" };

describe("envelope and derived timeline (§3.1)", () => {
  it("writes the construction heartbeat in the exact closed format plus newline", () => {
    const h = harness();
    expect(h.writes).toEqual([
      `[cards-metric] {"v":1,"inc":"${h.sink.inc}","seq":1,"name":"telemetry_heartbeat_total","labels":{"level":"info"},`
      + '"value":1,"w_utc":"2026-10-15T08:00:00.000Z","t_utc":"2026-10-15T08:00:00.000Z","t_mono":1000.5}\n',
    ]);
    expect(h.sink.inc).toMatch(/^i[0-9a-f]{16}$/);
  });

  it("sorts labels, inserts the registry level and increments seq", () => {
    const h = harness();
    h.at(1500);
    expect(h.sink.emit("capability_state_total", { code: "enabled", capability: "automatic", bot_ref: BOT }, 1)).toBe("emitted");
    const o = body(h.lines[1]);
    expect(Object.keys(o)).toEqual(["v", "inc", "seq", "name", "labels", "value", "t_utc", "t_mono"]);
    expect(Object.keys(o.labels as object)).toEqual(["bot_ref", "capability", "code", "level"]);
    expect(o).toMatchObject({ seq: 2, value: 1, t_utc: new Date(B + 1500).toISOString(), t_mono: 2500.5 });
  });

  it("keeps one fixed construction anchor: wall steps change w_utc only", () => {
    const h = harness();
    h.wallOffset = 1_700_000;
    h.at(60_000);
    h.sink.heartbeat();
    const beat = body(h.lines[1]);
    expect(beat.t_utc).toBe(new Date(B + 60_000).toISOString());
    expect(beat.w_utc).toBe(new Date(B + 60_000 + 1_700_000).toISOString());
  });

  it("rejects unsupported clock policies at construction", () => {
    const base = { wall: { nowUtcMs: () => B }, mono: { nowMono: () => 0 }, write: () => undefined };
    expect(() => createTelemetrySink({ ...base, clockPolicy: "B" as never })).toThrow(TelemetryConfigError);
  });

  it("draws every incarnation id from 64 fresh random bits; no caller value can choose it", () => {
    const base = { wall: { nowUtcMs: () => B }, mono: { nowMono: () => 0 }, write: () => undefined };
    const rb = vi.mocked(randomBytes);
    rb.mockClear();
    rb.mockImplementationOnce(() => Buffer.from("0123456789abcdef", "hex"));
    const forced = createTelemetrySink({ ...base, incHex: "a".repeat(16) } as never);
    expect(forced.inc).toBe("i0123456789abcdef");
    expect(rb).toHaveBeenCalledTimes(1);
    expect(rb).toHaveBeenCalledWith(8);
    const incs = new Set(Array.from({ length: 32 }, () => createTelemetrySink({ ...base, incHex: "b".repeat(16) } as never).inc));
    expect(incs.size).toBe(32);
    for (const inc of incs) expect(inc).toMatch(/^i[0-9a-f]{16}$/);
  });
});

describe("label snapshot and validation (§3.6)", () => {
  const rejectedWith = (labels: unknown): string => {
    const h = harness();
    expect(h.sink.emit("capability_state_total", labels as never, 1)).toBe("rejected");
    return Object.keys(h.sink.snapshotHealth().health).find((k) => k.startsWith("rejected_"))!;
  };

  it("maps every label fault to its closed code", () => {
    expect(rejectedWith({ ...CAP, level: "info" })).toBe("rejected_label_not_allowed");
    expect(rejectedWith({ ...CAP, topology: "t_part" })).toBe("rejected_label_not_allowed");
    expect(rejectedWith({ ...CAP, extra: "x" })).toBe("rejected_unknown_label");
    expect(rejectedWith({ bot_ref: BOT, capability: "automatic" })).toBe("rejected_missing_label");
    expect(rejectedWith({ ...CAP, code: "ENABLED" })).toBe("rejected_invalid_label_value");
    expect(rejectedWith({ ...CAP, bot_ref: "b" + "G".repeat(16) })).toBe("rejected_invalid_label_value");
    expect(rejectedWith({ ...CAP, code: 1 })).toBe("rejected_invalid_label_value");
  });

  it("never runs proxy traps or getters and rejects exotic objects as invalid_labels", () => {
    let touched = 0;
    const proxy = new Proxy({ ...CAP }, { get: () => { touched++; return "x"; }, ownKeys: () => { touched++; return []; } });
    expect(rejectedWith(proxy)).toBe("rejected_invalid_labels");
    const getter = Object.defineProperty({ bot_ref: BOT, capability: "automatic" }, "code", { get: () => { touched++; return "enabled"; }, enumerable: true });
    expect(rejectedWith(getter)).toBe("rejected_invalid_labels");
    expect(touched).toBe(0);
    expect(rejectedWith({ ...CAP, [Symbol("s")]: "x" })).toBe("rejected_invalid_labels");
    expect(rejectedWith(Object.defineProperty({ ...CAP }, "hidden", { value: "x", enumerable: false }))).toBe("rejected_invalid_labels");
    expect(rejectedWith(new (class L { bot_ref = BOT; capability = "automatic"; code = "enabled"; })())).toBe("rejected_invalid_labels");
    expect(rejectedWith([BOT])).toBe("rejected_invalid_labels");
    expect(rejectedWith(null)).toBe("rejected_invalid_labels");
    expect(rejectedWith({ a: "1", b: "2", c: "3", d: "4", e: "5", f: "6", g: "7" })).toBe("rejected_invalid_labels");
    const h = harness();
    expect(h.sink.emit("capability_state_total", Object.assign(Object.create(null), CAP), 1)).toBe("emitted");
  });

  it("validates counter and duration values with sanctioned saturation only", () => {
    const h = harness();
    for (const v of [0, 1001, 1.5, Number.NaN, Infinity, -1, "1"]) expect(h.sink.emit("capability_state_total", CAP, v as number)).toBe("rejected");
    const ff = { bot_ref: BOT, origin_ref: O, route_type: "dm", capability: "automatic" };
    expect(h.sink.emit("first_frame_ms", ff, -0)).toBe("emitted");
    expect(h.sink.emit("first_frame_ms", ff, 1.2)).toBe("emitted");
    expect(h.sink.emit("first_frame_ms", ff, 86_400_001)).toBe("emitted_degraded");
    expect(h.sink.emit("first_frame_ms", ff, -0.5)).toBe("rejected");
    const values = h.lines.map(body).filter((o) => o.name === "first_frame_ms").map((o) => o.value);
    expect(values).toEqual([0, 2, 86_400_000]);
    expect(Object.is(values[0], -0)).toBe(false);
  });
});

describe("rejection effects and loss spans (§3.6)", () => {
  it("records loss only for loss-bearing rows and flushes it before the next line", () => {
    const h = harness();
    h.at(1000);
    h.sink.emit("capability_state_total", { ...CAP, code: "bogus" }, 1);
    expect(names(h.lines)).toEqual(["telemetry_heartbeat_total", "telemetry_rejected_total"]);
    h.sink.emit("first_frame_ms", { bot_ref: BOT, origin_ref: O, route_type: "dm", capability: "display" }, 5);
    // The pending loss is flushed as #32 before the rejection line itself (§3.7 strict ordering).
    expect(names(h.lines)).toEqual(["telemetry_heartbeat_total", "telemetry_rejected_total", "telemetry_loss_total", "telemetry_rejected_total"]);
    const loss = body(h.lines[2]);
    expect(loss).toMatchObject({ labels: { code: "invalid_label_value", level: "warn" }, value: 1, iv_start: new Date(B + 1000).toISOString(), iv_end: new Date(B + 1000).toISOString() });
    expect(body(h.lines[3]).labels).toEqual({ code: "invalid_label_value", level: "warn" });
    expect(h.sink.snapshotHealth().pending).toEqual({});
    expect(h.sink.snapshotHealth().health).toMatchObject({ rejected_invalid_label_value: 2 });
  });

  it("treats unknown names and wrong entry points as loss-bearing unknown_metric", () => {
    const h = harness();
    expect(h.sink.emit("telemetry_loss_total" as never, { code: "sink_failed" }, 1)).toBe("rejected");
    expect(h.sink.emit("cooldown_slice_ms" as never, { origin_ref: O, code: "client_backoff" }, 1)).toBe("rejected");
    expect(h.sink.emitInterval("card_send_total" as never, {}, 0, 1)).toBe("rejected");
    const losses = h.lines.map(body).filter((o) => o.name === "telemetry_loss_total");
    expect(losses.map((o) => (o.labels as Record<string, string>).code)).toEqual(["unknown_metric", "unknown_metric", "unknown_metric"]);
  });

  it("derives #17 values from the fixed timeline and enforces the slice bounds", () => {
    const h = harness();
    h.at(200_000);
    const lab = { origin_ref: O, code: "client_backoff" };
    const m = 1000.5 + 200_000;
    expect(h.sink.emitInterval("cooldown_slice_ms", lab, m - 60_000, m)).toBe("emitted");
    expect(body(h.lines[1])).toMatchObject({ value: 60_000, iv_start: new Date(B + 140_000).toISOString(), iv_end: new Date(B + 200_000).toISOString() });
    expect(h.sink.emitInterval("cooldown_slice_ms", lab, m - 61_001, m)).toBe("rejected");
    expect(h.sink.emitInterval("cooldown_slice_ms", lab, m - 1000, m + 1)).toBe("rejected");
    expect(h.sink.emitInterval("cooldown_slice_ms", lab, m - 122_001, m - 122_000 + 1000)).toBe("rejected");
    expect(h.sink.emitInterval("cooldown_slice_ms", lab, m, m)).toBe("not_emitted_empty");
    expect(h.sink.emitInterval("cooldown_slice_ms", lab, Number.NaN, m)).toBe("rejected");
  });

  it("bounds the loss span of malformed interval calls", () => {
    const h = harness();
    h.at(200_000);
    h.sink.emitInterval("cooldown_slice_ms", { origin_ref: O, code: "client_backoff" }, Number.NaN, Infinity);
    h.at(200_500);
    h.sink.heartbeat();
    const loss = h.lines.map(body).find((o) => o.name === "telemetry_loss_total")!;
    expect([Date.parse(loss.iv_start as string) - B, Date.parse(loss.iv_end as string) - B]).toEqual([139_000, 200_000]);
  });

  it("saturates #34 at 30 days and checks its start skew", () => {
    const h = harness();
    h.at(5000);
    const m = 1000.5 + 5000;
    const lab = { origin_ref: O, code: "server_retry_after" };
    expect(h.sink.emitInterval("cooldown_mandated_ms", lab, m, m + 3_000_000_000)).toBe("emitted_degraded");
    expect(body(h.lines[1]).value).toBe(2_592_000_000);
    expect(h.sink.emitInterval("cooldown_mandated_ms", lab, m - 1001, m + 10)).toBe("rejected");
    expect(h.sink.emitInterval("cooldown_mandated_ms", lab, m, m)).toBe("rejected");
    expect(h.sink.emitInterval("cooldown_mandated_ms", { ...lab, code: "client_backoff" }, m, m + 10)).toBe("rejected");
  });
});

describe("internal faults on interval rows (IE-34)", () => {
  const lossOf = (h: ReturnType<typeof harness>) => {
    const l = h.lines.map(body).find((o) => o.name === "telemetry_loss_total" && (o.labels as Record<string, string>).code === "internal_error")!;
    return [Date.parse(l.iv_start as string) - B, Date.parse(l.iv_end as string) - B];
  };
  const withThrowing = <T>(target: object, key: string, run: () => T): T => {
    const original = (target as Record<string, unknown>)[key];
    (target as Record<string, unknown>)[key] = () => { throw new Error("forced"); };
    try { return run(); } finally { (target as Record<string, unknown>)[key] = original; }
  };

  it("records the #34 covered interval [now, now + 300 s] after a late internal fault", () => {
    const h = harness();
    h.at(200_000);
    const m = 1000.5 + 200_000;
    const r = withThrowing(Buffer, "byteLength", () => h.sink.emitInterval("cooldown_mandated_ms", { origin_ref: O, code: "server_retry_after" }, m, m + 300_000));
    expect(r).toBe("rejected");
    expect(lossOf(h)).toEqual([200_000, 500_000]);
  });

  it("uses the known row's loss span, not the unknown-row fallback, for an early internal fault", () => {
    const h34 = harness();
    h34.at(200_000);
    const r34 = withThrowing(Reflect, "ownKeys", () => h34.sink.emitInterval("cooldown_mandated_ms", { origin_ref: O, code: "server_retry_after" }, 1000.5 + 200_000, Infinity));
    expect(r34).toBe("rejected");
    expect(lossOf(h34)).toEqual([200_000, 200_000 + 2_592_000_000]);
    const h17 = harness();
    h17.at(200_000);
    withThrowing(Reflect, "ownKeys", () => h17.sink.emitInterval("cooldown_slice_ms", { origin_ref: O, code: "client_backoff" }, Number.NaN, 1000.5 + 200_000));
    expect(lossOf(h17)).toEqual([139_000, 200_000]);
    const hc = harness();
    hc.at(200_000);
    const m = 1000.5 + 200_000;
    withThrowing(Reflect, "ownKeys", () => hc.sink.emitInterval("cooldown_mandated_ms", { origin_ref: O, code: "server_retry_after" }, m - 1_000_000_000, m + 3_000_000_000));
    expect(lossOf(hc)).toEqual([200_000 - 122_000, 200_000 - 1_000_000_000 + 2_592_000_000]);
  });
});

describe("cardinality (§3.6 step 8)", () => {
  const bot = (i: number): string => "b" + i.toString(16).padStart(16, "0");
  it("caps Bots at 64 and origins at 16; #29 drops bot_ref instead (T1)", () => {
    const h = harness();
    for (let i = 0; i < 64; i++) expect(h.sink.emit("stale_sequence_total", { bot_ref: bot(i), capability: "display" }, 1)).toBe("emitted");
    expect(h.sink.emit("stale_sequence_total", { bot_ref: bot(64), capability: "display" }, 1)).toBe("rejected");
    expect(h.sink.emit("stale_sequence_total", { bot_ref: bot(3), capability: "display" }, 1)).toBe("emitted");
    expect(h.sink.emit("critical_signal_total", { bot_ref: bot(65), capability: "display", code: "protected_token" }, 1)).toBe("emitted_degraded");
    const crit = h.lines.map(body).find((o) => o.name === "critical_signal_total")!;
    expect(crit.labels).toEqual({ capability: "display", code: "protected_token", level: "critical" });
    const org = (i: number): string => "o" + i.toString(16).padStart(16, "0");
    for (let i = 0; i < 16; i++) expect(h.sink.emit("cooldown_start_total", { origin_ref: org(i), code: "client_backoff" }, 1)).toBe("emitted");
    expect(h.sink.emit("cooldown_start_total", { origin_ref: org(16), code: "client_backoff" }, 1)).toBe("rejected");
    expect(h.sink.snapshotHealth().health.rejected_cardinality_exceeded).toBe(2);
  });

  it("does not consume slots for rejected lines", () => {
    const h = harness();
    for (let i = 0; i < 70; i++) h.sink.emit("stale_sequence_total", { bot_ref: bot(i), capability: "nope" }, 1);
    for (let i = 0; i < 64; i++) expect(h.sink.emit("stale_sequence_total", { bot_ref: bot(100 + i), capability: "display" }, 1)).toBe("emitted");
  });
});

describe("sink failure containment (§3.7)", () => {
  it("consumes no seq on a writer throw and flushes sink_failed before the next line", () => {
    const h = harness();
    h.fail = () => true;
    expect(h.sink.emit("capability_state_total", CAP, 1)).toBe("sink_failed");
    h.fail = () => false;
    h.at(10);
    expect(h.sink.emit("capability_state_total", CAP, 1)).toBe("emitted");
    const lines = h.lines.map(body);
    expect(lines.map((o) => [o.seq, o.name])).toEqual([[1, "telemetry_heartbeat_total"], [2, "telemetry_loss_total"], [3, "capability_state_total"]]);
    expect(lines[1].labels).toEqual({ code: "sink_failed", level: "warn" });
  });

  it("withholds the triggering line when a pending flush fails, then flushes every retained loss", () => {
    const h = harness();
    h.at(100);
    h.fail = () => true;
    h.sink.emit("first_frame_ms", { bot_ref: BOT } as never, 1);
    expect(h.sink.snapshotHealth().pending).toMatchObject({ missing_label: 1 });
    h.fail = (l) => l.includes("telemetry_loss_total");
    h.at(200);
    expect(h.sink.emit("capability_state_total", CAP, 1)).toBe("sink_failed");
    // Both the earlier #30 rejection line and this ordinary line were withheld behind a failed flush.
    expect(h.sink.snapshotHealth().health.withheld_line).toBe(2);
    h.fail = () => false;
    h.at(300);
    h.sink.heartbeat();
    const losses = h.lines.map(body).filter((o) => o.name === "telemetry_loss_total");
    expect(losses.map((o) => (o.labels as Record<string, string>).code).sort()).toEqual(["missing_label", "sink_failed"]);
    expect(names(h.lines)).not.toContain("capability_state_total");
    expect(h.sink.snapshotHealth().pending).toEqual({});
  });

  it("splits more than 1000 pending losses into ≤ 1000 chunks", () => {
    const h = harness();
    h.drop = () => false;
    h.fail = () => true;
    for (let i = 0; i < 1500; i++) h.sink.emit("unresolved_claim_aged_total", { bot_ref: BOT }, 1);
    h.fail = () => false;
    h.sink.heartbeat();
    const chunks = h.lines.map(body).filter((o) => o.name === "telemetry_loss_total").map((o) => o.value);
    expect(chunks.reduce((a, b) => (a as number) + (b as number), 0)).toBeGreaterThanOrEqual(1500);
    expect(chunks.every((v) => (v as number) <= 1000)).toBe(true);
  });

  it("never reads a thrown value and never throws out of an entry point", () => {
    let read = 0;
    const hostile = new Proxy({}, { get: () => { read++; return () => "x"; } });
    const sink = createTelemetrySink({
      wall: { nowUtcMs: () => B }, mono: { nowMono: () => 0 },
      write: () => { throw hostile; },
    });
    expect(sink.emit("capability_state_total", CAP, 1)).toBe("sink_failed");
    expect(sink.heartbeat()).toBe("sink_failed");
    expect(sink.closeSink()).toBe("sink_failed");
    expect(sink.reportAsyncSinkError()).toBeUndefined();
    expect(read).toBe(0);
    const throwingClock = createTelemetrySink({
      wall: { nowUtcMs: () => { throw hostile; } }, mono: { nowMono: () => { throw hostile; } }, write: () => undefined,
    });
    expect(throwingClock.emit("capability_state_total", CAP, 1)).toBe("rejected");
    expect(read).toBe(0);
  });
});

describe("clocks, close and async diagnostics (§3.7, §3.8)", () => {
  it("is dead with an out-of-domain construction clock: writes nothing, rejects everything", () => {
    for (const [w, m] of [[Number.NaN, 0], [B, -1], [B, 1e12 + 1], [253_402_300_800_000, 0], [B, Infinity]]) {
      const lines: string[] = [];
      const sink = createTelemetrySink({ wall: { nowUtcMs: () => w }, mono: { nowMono: () => m }, write: (l) => { lines.push(l); } });
      expect(sink.emit("capability_state_total", CAP, 1)).toBe("rejected");
      expect(sink.heartbeat()).toBe("rejected");
      expect(sink.closeSink()).toBe("rejected");
      expect(sink.reportAsyncSinkError()).toBeUndefined();
      expect(lines).toEqual([]);
    }
  });

  it("rejects with clock_invalid and an open-ended loss when mono becomes invalid", () => {
    let m = 0;
    const lines: string[] = [];
    const sink = createTelemetrySink({ wall: { nowUtcMs: () => B + m }, mono: { nowMono: () => m }, write: (l) => { lines.push(l); } });
    m = Number.NaN;
    expect(sink.emit("first_frame_ms", { bot_ref: BOT, origin_ref: O, route_type: "dm", capability: "automatic" }, 1)).toBe("rejected");
    expect(sink.snapshotHealth().pending).toEqual({ clock_invalid: 1 });
    m = 5000;
    sink.heartbeat();
    const loss = lines.map(body).find((o) => o.name === "telemetry_loss_total")!;
    expect([loss.iv_start, loss.iv_end]).toEqual([new Date(B).toISOString(), new Date(B + 5000).toISOString()]);
  });

  it("makes an invalid heartbeat wall clock a loss-bearing clock_invalid", () => {
    const h = harness();
    h.wallOffset = Number.NaN;
    h.at(60_000);
    expect(h.sink.heartbeat()).toBe("rejected");
    const loss = h.lines.map(body).find((o) => o.name === "telemetry_loss_total")!;
    expect(loss).toMatchObject({ labels: { code: "clock_invalid", level: "warn" }, iv_start: new Date(B + 60_000).toISOString() });
  });

  it("writes #33 once, then rejects every later call", () => {
    const h = harness();
    h.at(10);
    expect(h.sink.closeSink()).toBe("emitted");
    expect(h.sink.closeSink()).toBe("rejected");
    expect(h.sink.emit("capability_state_total", CAP, 1)).toBe("rejected");
    expect(h.sink.heartbeat()).toBe("rejected");
    expect(names(h.lines)).toEqual(["telemetry_heartbeat_total", "telemetry_close_total"]);
  });

  it("does not write #33 after a failed flush", () => {
    const h = harness();
    h.sink.reportAsyncSinkError();
    h.fail = () => true;
    expect(h.sink.closeSink()).toBe("sink_failed");
    expect(names(h.lines)).not.toContain("telemetry_close_total");
  });

  it("reports async errors as a diagnostic [now − R, now] loss and returns undefined", () => {
    const h = harness();
    h.at(200_000);
    expect(h.sink.reportAsyncSinkError()).toBeUndefined();
    h.sink.heartbeat();
    const loss = h.lines.map(body).find((o) => o.name === "telemetry_loss_total")!;
    expect([Date.parse(loss.iv_start as string) - B, Date.parse(loss.iv_end as string) - B]).toEqual([78_000, 200_000]);
  });
});

describe("privacy canaries (AC-019.2 source scope)", () => {
  const CANARIES = [
    "sk-live-CANARY0000000000000000", "PASSWORD=hunter2CANARY", "https://user:pass@canary.example.co.uk/p?q#f",
    "/home/canary/.ssh/id_rsa", "eyJhbGciOiJIUzI1NiJ9.eyJjYW5hcnkiOjF9.sig", "‮canary​", "CANARY\u0007bell",
    "ghp_CANARYCANARYCANARYCANARY", "AKIACANARY0000000000",
  ];

  it("never writes, counts or echoes a hostile label value", () => {
    const h = harness();
    for (const c of CANARIES) {
      h.sink.emit("capability_state_total", { bot_ref: c, capability: "automatic", code: "enabled" }, 1);
      h.sink.emit("card_degraded_total", { bot_ref: BOT, capability: "display", route_type: "dm", code: c }, 1);
      h.sink.emit("critical_signal_total", { capability: "display", code: "protected_token", route_type: c }, 1);
      h.sink.emit("capability_state_total", { ...CAP, [c]: "x" }, 1);
      h.sink.emit(c as never, CAP, 1);
    }
    h.sink.heartbeat();
    const everything = h.writes.join("") + JSON.stringify(h.sink.snapshotHealth());
    for (const c of CANARIES) expect(everything).not.toContain(c);
    const parsed = parseCollection(h.lines);
    expect(parsed.parseFault).toBe(false);
    expect(parsed.lines.every((o) => Object.keys(o.labels).every((k) => ["bot_ref", "origin_ref", "capability", "route_type", "code", "topology", "level"].includes(k)))).toBe(true);
  });

  it("keeps the widest representable line under the 1024 B cap", () => {
    const h = harness();
    h.at(5000);
    const m = 1000.5 + 5000;
    h.sink.emitInterval("cooldown_mandated_ms", { origin_ref: O, code: "server_retry_after" }, m, m + 3_000_000_000);
    h.sink.emit("critical_signal_total", { bot_ref: BOT, capability: "interaction", code: "stale_terminal_overwrite", route_type: "topic", topology: "t_excl" }, 1000);
    for (const l of h.lines) expect(Buffer.byteLength(l)).toBeLessThan(1024);
  });
});
