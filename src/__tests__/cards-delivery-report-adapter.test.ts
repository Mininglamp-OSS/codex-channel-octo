import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic model events only; handler, relay, REST client and SQLite are real.
const agentScript: { events: unknown[]; throwAfter: boolean } = { events: [], throwAfter: false };
vi.mock("../agent-bridge.js", async importOriginal => ({
  ...await importOriginal<typeof import("../agent-bridge.js")>(),
  queryAgentEvents: vi.fn(async function* () {
    for (const ev of agentScript.events) yield ev;
    if (agentScript.throwAfter) throw new Error("synthetic stream failure");
  }),
}));

import {
  adaptDeliveryReport,
  FAILED_CLOSED_REPORT,
  readDeliveryReport,
  reportAllowsDone,
  type DeliveryPartRow,
  type DeliveryPartsReader,
} from "../cards/delivery-report.js";
import type { DeliveryReport } from "../cards/contracts.js";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { GroupContext } from "../group-context.js";
import { handleMessage } from "../index.js";
import { ChannelType, MessageType, type BotMessage } from "../octo/types.js";
import { SessionRouter } from "../session-router.js";
import { SessionStore } from "../session-store.js";
import { StreamRelay, type DeliveryReport as RelayDeliveryReport } from "../stream-relay.js";
import { TurnContext } from "../turn-context.js";
import type { Config } from "../config.js";

const row = (index: number, state: DeliveryPartRow["state"], messageId: string | null = null): DeliveryPartRow => ({ index, state, messageId });
const report = (expected: number, acked: number, failed: number, messageIds: string[], emptyNotice = false): DeliveryReport =>
  ({ expected, acked, failed, messageIds, emptyNotice });
const ZERO = report(0, 0, 0, []);

// ─── Pure arithmetic (§3.3 table) ───────────────────────────────────────────

describe("adaptDeliveryReport arithmetic", () => {
  it("all parts confirmed: n/n/0 with ledger ids in part order", () => {
    const parts = [row(0, "confirmed", "200"), row(1, "confirmed", "201"), row(2, "confirmed", "202")];
    expect(adaptDeliveryReport(parts, { emptyNotice: false })).toEqual(report(3, 3, 0, ["200", "201", "202"]));
    expect(adaptDeliveryReport([row(0, "confirmed", "101")], { emptyNotice: false })).toEqual(report(1, 1, 0, ["101"]));
  });

  it("fail-fast ledger: confirmed prefix, one unknown, never-sent pending counted as failed", () => {
    expect(adaptDeliveryReport([row(0, "confirmed", "300"), row(1, "unknown"), row(2, "pending")], { emptyNotice: false }))
      .toEqual(report(3, 1, 2, ["300"]));
    expect(adaptDeliveryReport([row(0, "confirmed", "300"), row(1, "confirmed", "301"), row(2, "unknown")], { emptyNotice: false }))
      .toEqual(report(3, 2, 1, ["300", "301"]));
  });

  it("first part unknown: n/0/n with no ids", () => {
    expect(adaptDeliveryReport([row(0, "unknown"), row(1, "pending"), row(2, "pending")], { emptyNotice: false })).toEqual(report(3, 0, 3, []));
  });

  it("an unknown part never contributes an id, even if one is present", () => {
    expect(adaptDeliveryReport([row(0, "unknown", "999")], { emptyNotice: false })).toEqual(report(1, 0, 1, []));
  });

  it("no ledger rows: zero counts, emptyNotice passed through", () => {
    expect(adaptDeliveryReport([], { emptyNotice: false })).toEqual(ZERO);
    expect(adaptDeliveryReport([], { emptyNotice: true })).toEqual(report(0, 0, 0, [], true));
  });

  it("keeps ids as ledger strings without re-classifying them", () => {
    const ids = ["9223372036854775807", "12345678901234567", "1"];
    expect(adaptDeliveryReport(ids.map((id, i) => row(i, "confirmed", id)), { emptyNotice: false }).messageIds).toEqual(ids);
  });

  it("returns a frozen report that does not alias the input", () => {
    const parts = [row(0, "confirmed", "7")];
    const out = adaptDeliveryReport(parts, { emptyNotice: false });
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.messageIds)).toBe(true);
    (parts[0] as { messageId: string | null }).messageId = "8";
    expect(out.messageIds).toEqual(["7"]);
  });

  it("returns the card leaf type, distinct from the relay report", () => {
    expectTypeOf(adaptDeliveryReport).returns.toEqualTypeOf<DeliveryReport>();
    expectTypeOf<RelayDeliveryReport>().not.toEqualTypeOf<DeliveryReport>();
  });
});

// ─── Fail-closed faults ─────────────────────────────────────────────────────

describe("adaptDeliveryReport fail-closed faults", () => {
  const faults: Array<[string, unknown, unknown]> = [
    ["non-array parts", null, { emptyNotice: false }],
    ["non-array object", { length: 1, 0: row(0, "confirmed", "1") }, { emptyNotice: false }],
    ["null part", [null], { emptyNotice: false }],
    ["unknown state", [{ index: 0, state: "sent", messageId: "1" }], { emptyNotice: false }],
    ["index gap", [row(0, "confirmed", "1"), row(2, "confirmed", "2")], { emptyNotice: false }],
    ["index out of order", [row(1, "confirmed", "1"), row(0, "confirmed", "2")], { emptyNotice: false }],
    ["duplicate index", [row(0, "confirmed", "1"), row(0, "confirmed", "2")], { emptyNotice: false }],
    ["confirmed without id", [row(0, "confirmed", null)], { emptyNotice: false }],
    ["confirmed with empty id", [row(0, "confirmed", "")], { emptyNotice: false }],
    ["confirmed with numeric id", [{ index: 0, state: "confirmed", messageId: 1 }], { emptyNotice: false }],
    ["emptyNotice with ledger rows", [row(0, "confirmed", "1")], { emptyNotice: true }],
    ["missing opts", [], undefined],
    ["non-boolean emptyNotice", [], { emptyNotice: "true" }],
    ["throwing getter", [Object.defineProperty({ index: 0, messageId: "1" }, "state", { get() { throw new Error("boom"); } })], { emptyNotice: false }],
  ];
  for (const [label, parts, opts] of faults) {
    it(`${label} → {0,0,0,[],false} without throwing`, () => {
      const call = () => adaptDeliveryReport(parts as readonly DeliveryPartRow[], opts as { emptyNotice: boolean });
      expect(call).not.toThrow();
      expect(call()).toEqual(ZERO);
      expect(reportAllowsDone(call())).toBe(false);
    });
  }

  it("the substitute report is frozen and never Done", () => {
    expect(FAILED_CLOSED_REPORT).toEqual(ZERO);
    expect(Object.isFrozen(FAILED_CLOSED_REPORT)).toBe(true);
    expect(Object.isFrozen(FAILED_CLOSED_REPORT.messageIds)).toBe(true);
    expect(reportAllowsDone(FAILED_CLOSED_REPORT)).toBe(false);
  });
});

// ─── Done shapes (C3 rules 3 and 4) ─────────────────────────────────────────

describe("reportAllowsDone", () => {
  it("accepts exactly the two normal-return shapes", () => {
    expect(reportAllowsDone(report(3, 3, 0, ["1", "2", "3"]))).toBe(true);
    expect(reportAllowsDone(report(0, 0, 0, [], true))).toBe(true);
  });

  it("rejects the all-zero report without an acknowledged notice", () => {
    expect(reportAllowsDone(report(0, 0, 0, []))).toBe(false);
  });

  it("rejects partial, failed and inconsistent shapes", () => {
    for (const r of [
      report(3, 2, 1, ["1", "2"]),
      report(3, 0, 3, []),
      report(3, 3, 1, ["1", "2", "3"]),
      report(3, 3, 0, ["1", "2"]),
      report(2, 3, 0, ["1", "2", "3"]),
      report(0, 0, 0, ["1"], true),
      report(0, 0, 1, [], true),
      report(1, 1, 0, ["1"], true),
      report(-1, -1, 0, [], false),
      report(1.5, 1.5, 0, ["1"]),
    ]) expect(reportAllowsDone(r)).toBe(false);
  });

  it("is fail-closed on malformed input", () => {
    for (const r of [null, undefined, {}, { expected: 1, acked: 1, failed: 0, messageIds: "1", emptyNotice: false }]) {
      expect(reportAllowsDone(r as unknown as DeliveryReport)).toBe(false);
    }
  });

  it("rejects a full-count report whose ids are not all non-empty strings", () => {
    for (const ids of [[""], [1], [null], ["1", ""], ["1", undefined], [{}, "2"]]) {
      const r = { expected: ids.length, acked: ids.length, failed: 0, messageIds: ids, emptyNotice: false };
      expect(reportAllowsDone(r as unknown as DeliveryReport)).toBe(false);
    }
    expect(reportAllowsDone(report(2, 2, 0, ["1", "2"]))).toBe(true);
  });

  it("rejects sparse id arrays, whose holes iteration helpers skip", () => {
    const leading: string[] = []; leading[1] = "2";
    const middle: string[] = ["1"]; middle[2] = "3";
    for (const ids of [new Array(1), new Array(3), leading, middle, ["1", , "3"]] as unknown[][]) {
      const r = { expected: ids.length, acked: ids.length, failed: 0, messageIds: ids, emptyNotice: false };
      expect(reportAllowsDone(r as unknown as DeliveryReport)).toBe(false);
    }
  });
});

describe("adaptDeliveryReport sparse input", () => {
  it("treats a hole in the parts array as a fault", () => {
    const tail: DeliveryPartRow[] = [row(0, "confirmed", "1")]; tail.length = 2;
    for (const parts of [new Array(1), tail, [row(0, "confirmed", "1"), , row(2, "confirmed", "3")]] as DeliveryPartRow[][]) {
      expect(adaptDeliveryReport(parts, { emptyNotice: false })).toEqual(ZERO);
    }
  });
});

// ─── Store read port ────────────────────────────────────────────────────────

describe("SessionStore.readDeliveryParts", () => {
  let root: string; let adapter: DbAdapter; let store: SessionStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wp07p-store-"));
    adapter = createAdapter(join(root, "sessions.db"));
    store = new SessionStore(adapter); store.init();
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  const totalChanges = () => (adapter.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const rawRows = () => adapter.prepare("SELECT * FROM delivery_parts ORDER BY rowid").all();

  it("returns [] for a turn with no ledger", () => {
    expect(store.readDeliveryParts("missing")).toEqual([]);
  });

  it("maps rows by part_index, independent of insert order", () => {
    store.saveDeliveryPart("t1", 2, "k2", "{}");
    store.saveDeliveryPart("t1", 0, "k0", "{}");
    store.saveDeliveryPart("t1", 1, "k1", "{}");
    store.markDeliveryPart("t1", 0, "confirmed", "500");
    store.markDeliveryPart("t1", 1, "unknown");
    expect(store.readDeliveryParts("t1")).toEqual([row(0, "confirmed", "500"), row(1, "unknown"), row(2, "pending")]);
  });

  it("reads only the exact turn, not the latest turn of the session", () => {
    store.saveTurnOutput("t1", "s", "first");
    store.saveDeliveryParts("t1", [{ clientMsgNo: "a", payload: "{}" }, { clientMsgNo: "b", payload: "{}" }]);
    store.markDeliveryPart("t1", 0, "confirmed", "1");
    store.saveTurnOutput("t2", "s", "second");
    store.saveDeliveryParts("t2", [{ clientMsgNo: "c", payload: "{}" }]);
    store.markDeliveryPart("t2", 0, "confirmed", "2");
    expect(store.readDeliveryParts("t1")).toEqual([row(0, "confirmed", "1"), row(1, "pending")]);
    expect(store.readDeliveryParts("t2")).toEqual([row(0, "confirmed", "2")]);
  });

  it("is read-only: no row or change-counter movement", () => {
    store.saveDeliveryParts("t1", [{ clientMsgNo: "a", payload: "{\"x\":1}" }]);
    store.markDeliveryPart("t1", 0, "confirmed", "9");
    const before = rawRows(); const changes = totalChanges();
    for (let i = 0; i < 3; i++) store.readDeliveryParts("t1");
    expect(rawRows()).toEqual(before);
    expect(totalChanges()).toBe(changes);
  });

  it("never exposes payload or client_msg_no", () => {
    store.saveDeliveryParts("t1", [{ clientMsgNo: "secret-key", payload: "{\"content\":\"secret\"}" }]);
    const out = store.readDeliveryParts("t1");
    expect(Object.keys(out[0]).sort()).toEqual(["index", "messageId", "state"]);
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("feeds the adapter directly through the read port", () => {
    store.saveDeliveryParts("t1", [{ clientMsgNo: "a", payload: "{}" }, { clientMsgNo: "b", payload: "{}" }]);
    store.markDeliveryPart("t1", 0, "confirmed", "41");
    store.markDeliveryPart("t1", 1, "confirmed", "42");
    expect(adaptDeliveryReport(store.readDeliveryParts("t1"), { emptyNotice: false })).toEqual(report(2, 2, 0, ["41", "42"]));
    expect(readDeliveryReport(store, "t1", { emptyNotice: false })).toEqual(report(2, 2, 0, ["41", "42"]));
  });

  it("a closed store substitutes the fail-closed report", () => {
    store.saveDeliveryParts("t1", [{ clientMsgNo: "a", payload: "{}" }]);
    store.markDeliveryPart("t1", 0, "confirmed", "1");
    store.close();
    expect(readDeliveryReport(store, "t1", { emptyNotice: false })).toEqual(ZERO);
    store = new SessionStore(createAdapter(join(root, "sessions.db"))); store.init();
  });
});

// ─── Read composition (C3 rule 5) ───────────────────────────────────────────

describe("readDeliveryReport", () => {
  it("passes exactly the given turn ID to the read port", () => {
    const reader = { readDeliveryParts: vi.fn<(turnId: string) => DeliveryPartRow[]>(() => [row(0, "confirmed", "1")]) };
    readDeliveryReport(reader, "turn-exact", { emptyNotice: false });
    expect(reader.readDeliveryParts).toHaveBeenCalledTimes(1);
    expect(reader.readDeliveryParts).toHaveBeenCalledWith("turn-exact");
  });

  it("substitutes {0,0,0,[],false} when the read throws, even for the empty-notice path", () => {
    const reader: DeliveryPartsReader = { readDeliveryParts: () => { throw new Error("SQLITE_BUSY"); } };
    expect(readDeliveryReport(reader, "t", { emptyNotice: false })).toEqual(ZERO);
    expect(readDeliveryReport(reader, "t", { emptyNotice: true })).toEqual(ZERO);
    expect(reportAllowsDone(readDeliveryReport(reader, "t", { emptyNotice: true }))).toBe(false);
  });

  it("rejects an empty or non-string turn ID without reading", () => {
    const reader = { readDeliveryParts: vi.fn(() => [] as DeliveryPartRow[]) };
    expect(readDeliveryReport(reader, "", { emptyNotice: true })).toEqual(ZERO);
    expect(readDeliveryReport(reader, undefined as unknown as string, { emptyNotice: true })).toEqual(ZERO);
    expect(reader.readDeliveryParts).not.toHaveBeenCalled();
  });

  it("a reader returning garbage yields the fail-closed report", () => {
    const reader = { readDeliveryParts: () => "nope" as unknown as DeliveryPartRow[] };
    expect(readDeliveryReport(reader, "t", { emptyNotice: false })).toEqual(ZERO);
  });
});

// ─── Boundary: relay stays untouched and independent of cards ───────────────

describe("WP-07′ boundary", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
  it("neither the relay nor the session store imports card modules", () => {
    for (const p of ["stream-relay.ts", "session-store.ts"]) expect(src(p)).not.toMatch(/from\s+['"][^'"]*cards\//);
  });
  it("the adapter imports nothing but card contract types", () => {
    const imports = [...src("cards/delivery-report.ts").matchAll(/^import\s.*from\s+["']([^"']+)["']/gm)].map(m => m[1]);
    expect(imports).toEqual(["./contracts.js"]);
  });
});

// ─── S04-M parity (handler level, real relay + SQLite) ──────────────────────

type Path = "return" | "catch" | "abort";
const NOTICE = "[No response generated. Please try rephrasing your question.]";
const THREE = ["A".repeat(3000), "B".repeat(3000), "C".repeat(3000)].join("\n\n");
const ok = (id: string) => new Response(`{"message_id":${id},"client_msg_no":"server-generated-key","message_seq":7}`);
const answerEvents = (text: string) => [
  { kind: "attempt_start", attempt: 0, reason: "initial", continues: null },
  { kind: "message", attempt: 0, itemId: "answer", seq: 0, text, phase: "unknown" },
  { kind: "attempt_end", attempt: 0, terminal: "completed" },
];
const emptyEvents = () => [
  { kind: "attempt_start", attempt: 0, reason: "initial", continues: null },
  { kind: "attempt_end", attempt: 0, terminal: "completed" },
];

describe("S04-M parity", () => {
  let root: string; let adapter: DbAdapter; let store: SessionStore; let config: Config; let router: SessionRouter;
  let sends: string[]; let failures: unknown[];

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "wp07p-s04m-"));
    adapter = createAdapter(join(root, "sessions.db"));
    store = new SessionStore(adapter); store.init();
    config = { botToken: "FAKE_TEST_TOKEN", apiUrl: "https://test.invalid", cwd: join(root, "ws"),
      dataDir: join(root, "data"), sdk: {}, rateLimit: { maxPerMinute: 100 },
      context: { maxContextChars: 6000, historyLimit: 40 } } as Config;
    router = new SessionRouter(config, "bot", "owner", store);
    sends = []; failures = [];
    agentScript.events = []; agentScript.throwAfter = false;
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { if (a[0] === "[codex-channel-octo] turn failed") failures.push(a[1]); });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); try { store.close(); } catch { /* closed */ } rmSync(root, { recursive: true, force: true }); });

  function stub(responder: (i: number, init: RequestInit) => Promise<Response> | Response) {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).endsWith("/v1/bot/sendMessage")) return new Response("{}");
      sends.push(JSON.parse(String(init?.body)).payload.content);
      return responder(sends.length - 1, init ?? {});
    }));
  }
  function msg(n: number): BotMessage {
    return { message_id: `incoming-${n}`, message_seq: n, from_uid: "human", from_name: "Human",
      channel_id: "human", channel_type: ChannelType.DM, timestamp: 0,
      payload: { type: MessageType.Text, content: `request ${n}` } };
  }
  async function turn(n = 1): Promise<string> {
    await handleMessage(msg(n), config, store, router, new GroupContext(adapter, 6000), new StreamRelay(), "bot");
    await new Promise(r => setTimeout(r, 0));
    return (adapter.prepare("SELECT turn_id FROM turn_execution").get() as { turn_id: string }).turn_id;
  }
  const outputState = (turnId: string) =>
    (adapter.prepare("SELECT state FROM turn_outputs WHERE turn_id=?").get(turnId) as { state: string } | undefined)?.state;

  /**
   * Derive the card report exactly as the coordinator would (C3), then check
   * that Done agrees with main: Done ⇔ history committed, or the normal-return
   * empty notice resolved. A catch/abort path is never Done.
   */
  function parity(turnId: string, path: Path, expected: DeliveryReport) {
    const emptyNoticeResolved = path === "return" && outputState(turnId) === undefined && sends.at(-1) === NOTICE;
    const r = readDeliveryReport(store, turnId, { emptyNotice: emptyNoticeResolved });
    expect(r).toEqual(expected);
    const done = path === "return" && reportAllowsDone(r);
    expect(done).toBe(outputState(turnId) === "committed" || emptyNoticeResolved);
    expect(path === "catch").toBe(failures.length > 0);
    return { report: r, done };
  }

  it("C01a single part confirmed → 1/1/0, Done, history committed", async () => {
    agentScript.events = answerEvents("Hello S04M");
    stub(() => ok("101"));
    expect(parity(await turn(), "return", report(1, 1, 0, ["101"])).done).toBe(true);
  });

  it("C01b three parts confirmed → 3/3/0 in part order, Done", async () => {
    agentScript.events = answerEvents(THREE);
    stub(i => ok(String(200 + i)));
    expect(parity(await turn(), "return", report(3, 3, 0, ["200", "201", "202"])).done).toBe(true);
  });

  for (const [label, failAt] of [["first", 0], ["middle", 1], ["last", 2]] as const) {
    it(`C02-${label} transport error at part ${failAt} → fail-fast counts, not Done`, async () => {
      agentScript.events = answerEvents(THREE);
      stub(i => { if (i === failAt) throw new TypeError("fetch failed"); return ok(String(300 + i)); });
      const ids = [0, 1, 2].slice(0, failAt).map(i => String(300 + i));
      expect(parity(await turn(), "catch", report(3, failAt, 3 - failAt, ids)).done).toBe(false);
    });
  }

  it("C02-http500 at the middle part → 3/1/2, not Done", async () => {
    agentScript.events = answerEvents(THREE);
    stub(i => i === 1 ? new Response("boom", { status: 500 }) : ok(String(310 + i)));
    expect(parity(await turn(), "catch", report(3, 1, 2, ["310"])).done).toBe(false);
  });

  const idMatrix: Array<[string, string, string | null]> = [
    ["empty-object", "{}", null],
    ["null-id", "{\"message_id\":null}", null],
    ["zero", "{\"message_id\":0}", null],
    ["negative", "{\"message_id\":-5}", null],
    ["float", "{\"message_id\":1.5}", null],
    ["leading-zero-string", "{\"message_id\":\"0123\"}", null],
    ["leading-zero-raw", "{\"message_id\":0000000000000001}", null],
    ["gt-int64-raw", "{\"message_id\":9223372036854775808}", null],
    ["uuid-string", "{\"message_id\":\"550e8400-e29b-41d4-a716-446655440000\"}", null],
    ["whitespace-string", "{\"message_id\":\" 123\"}", null],
    ["safe-int-numeric", "{\"message_id\":12345}", "12345"],
    ["exponent-safe-value", "{\"message_id\":1e3}", "1000"],
    ["canonical-string", "{\"message_id\":\"12345\"}", "12345"],
    ["int64-max-raw", "{\"message_id\":9223372036854775807}", "9223372036854775807"],
    ["above-safe-raw-17digits", "{\"message_id\":12345678901234567}", "12345678901234567"],
  ];
  for (const [label, body, id] of idMatrix) {
    it(`C03 id=${label} → ${id ? "1/1/0 Done" : "1/0/1 not Done"} (main's confirmation rule)`, async () => {
      agentScript.events = answerEvents("ID probe");
      stub(i => i === 0 ? new Response(body) : ok("999"));
      const turnId = await turn();
      if (id) expect(parity(turnId, "return", report(1, 1, 0, [id])).done).toBe(true);
      else expect(parity(turnId, "catch", report(1, 0, 1, [])).done).toBe(false);
    });
  }

  it("C04 server client_msg_no differs from the request → still 1/1/0 Done", async () => {
    agentScript.events = answerEvents("Key echo probe");
    stub(() => new Response("{\"message_id\":4242,\"client_msg_no\":\"totally-different-server-key\"}"));
    expect(parity(await turn(), "return", report(1, 1, 0, ["4242"])).done).toBe(true);
  });

  it("C05a saveDeliveryParts failure → no ledger, {0,0,0,[],false}, not Done", async () => {
    adapter.exec("CREATE TRIGGER wp07p_fail BEFORE INSERT ON delivery_parts BEGIN SELECT RAISE(ABORT,'wp07p'); END;");
    agentScript.events = answerEvents(THREE);
    stub(i => ok(String(500 + i)));
    expect(parity(await turn(), "catch", ZERO).done).toBe(false);
  });

  it("C05b saveTurnOutput failure → {0,0,0,[],false}, not Done", async () => {
    adapter.exec("CREATE TRIGGER wp07p_fail BEFORE INSERT ON turn_outputs BEGIN SELECT RAISE(ABORT,'wp07p'); END;");
    agentScript.events = answerEvents("Output store probe");
    stub(i => ok(String(510 + i)));
    expect(parity(await turn(), "catch", ZERO).done).toBe(false);
  });

  it("C05c history append fails after every part confirmed → Done-shaped report, but the catch path is Error", async () => {
    adapter.exec("CREATE TRIGGER wp07p_fail BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'wp07p'); END;");
    agentScript.events = answerEvents(THREE);
    stub(i => ok(String(520 + i)));
    const { report: r, done } = parity(await turn(), "catch", report(3, 3, 0, ["520", "521", "522"]));
    expect(reportAllowsDone(r)).toBe(true);
    expect(done).toBe(false);
  });

  it("C06 abort during the middle part → 3/1/2; the abort path owns the terminal", async () => {
    agentScript.events = answerEvents(THREE);
    stub((i, init) => {
      if (i !== 1) return ok(String(600 + i));
      void router.stopTurns(0);
      return new Promise<Response>((_, reject) => {
        const sig = init.signal!;
        const fail = () => reject(new DOMException("aborted", "AbortError"));
        if (sig.aborted) fail(); else sig.addEventListener("abort", fail, { once: true });
      });
    });
    const turnId = await turn();
    await new Promise(r => setTimeout(r, 20));
    expect(parity(turnId, "abort", report(3, 1, 2, ["600"])).done).toBe(false);
  });

  it("C07a empty selection, notice 2xx without id → emptyNotice true, Done", async () => {
    agentScript.events = emptyEvents();
    stub(() => new Response("{}"));
    expect(parity(await turn(), "return", report(0, 0, 0, [], true)).done).toBe(true);
  });

  it("C07b empty selection, notice with non-canonical id → still Done (no stricter notice rule)", async () => {
    agentScript.events = [];
    stub(() => new Response("{\"message_id\":\"0123\"}"));
    expect(parity(await turn(), "return", report(0, 0, 0, [], true)).done).toBe(true);
  });

  it("C07c empty selection, notice send rejects → catch path, {0,0,0,[],false}, not Done", async () => {
    agentScript.events = [];
    stub(i => { if (i === 0) throw new TypeError("fetch failed"); return new Response("{}"); });
    const turnId = await turn();
    expect(sends[0]).toBe(NOTICE);
    expect(parity(turnId, "catch", ZERO).done).toBe(false);
  });

  it("C08a Unicode split → one id per part, Done", async () => {
    const text = "中".repeat(3499) + "😀" + "é".repeat(100) + "\u{1F468}‍\u{1F469}‍\u{1F467}" + "終";
    agentScript.events = answerEvents(text);
    stub(i => ok(String(800 + i)));
    expect(parity(await turn(), "return", report(2, 2, 0, ["800", "801"])).done).toBe(true);
  });

  it("C09-handler agent throws after text → nothing delivered, {0,0,0,[],false}", async () => {
    agentScript.events = answerEvents("partial-before-throw").slice(0, 2); agentScript.throwAfter = true;
    stub(i => ok(String(900 + i)));
    expect(parity(await turn(), "catch", ZERO).done).toBe(false);
  });

  it("C10 exact turn: a failed turn keeps its report after reconciliation and a later successful turn", async () => {
    agentScript.events = answerEvents(THREE);
    stub(i => i === 1 ? new Response("{}") : ok(String(1000 + i)));
    const t1 = await turn(1);
    const failed = report(3, 1, 2, ["1000"]);
    parity(t1, "catch", failed);
    const session = (adapter.prepare("SELECT session_key FROM turn_outputs WHERE turn_id=?").get(t1) as { session_key: string }).session_key;
    expect(store.reconcileTurn(session, t1)).toBe(true);
    failures = []; sends = [];
    agentScript.events = answerEvents("Second turn answer");
    stub(i => ok(String(1100 + i)));
    const t2 = await turn(2);
    expect(t2).not.toBe(t1);
    expect(sends).toEqual(["Second turn answer"]);
    parity(t2, "return", report(1, 1, 0, ["1100"]));
    expect(readDeliveryReport(store, t1, { emptyNotice: false })).toEqual(failed);
    expect(outputState(t1)).toBe("generated");
  });
});

// ─── S04-M parity (relay level) ─────────────────────────────────────────────

describe("S04-M parity (relay)", () => {
  let root: string; let store: SessionStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wp07p-relay-"));
    store = new SessionStore(createAdapter(join(root, "sessions.db"))); store.init();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); store.close(); rmSync(root, { recursive: true, force: true }); });

  async function* gen(chunks: string[], throwAfter: boolean) {
    for (const c of chunks) yield c;
    if (throwAfter) throw new Error("synthetic relay stream failure");
  }

  it("C09-relay partial flush then rethrow → 1/1/0 ledger, but the throw makes it a catch path", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/v1/bot/sendMessage") ? ok("1400") : new Response("{}")));
    const turn = new TurnContext(0);
    store.saveTurnOutput(turn.turnId, "dm", "x");
    const err = await new StreamRelay()
      .deliver("dm", ChannelType.DM, gen(["part-1 ", "part-2"], true), "https://test.invalid", "T", undefined, undefined, undefined, { turn, store: turn.guard(store) })
      .catch((e: unknown) => e);
    expect(String(err)).toContain("synthetic relay stream failure");
    const r = readDeliveryReport(store, turn.turnId, { emptyNotice: false });
    expect(r).toEqual(report(1, 1, 0, ["1400"]));
    // Rule 2: a catch path is Error regardless of counts.
  });

  it("matches the relay's own per-part report for the same turn", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/v1/bot/sendMessage") ? ok(String(1500 + n++)) : new Response("{}")));
    const turn = new TurnContext(0);
    store.saveTurnOutput(turn.turnId, "dm", "x");
    const relay = await new StreamRelay()
      .deliver("dm", ChannelType.DM, gen([THREE], false), "https://test.invalid", "T", undefined, undefined, undefined, { turn, store: turn.guard(store) });
    const r = readDeliveryReport(store, turn.turnId, { emptyNotice: false });
    expect(r.messageIds).toEqual(relay.parts.map(p => p.messageId));
    expect(r.acked).toBe(relay.parts.filter(p => p.state === "confirmed").length);
    expect(r.expected).toBe(relay.parts.length);
  });
});
