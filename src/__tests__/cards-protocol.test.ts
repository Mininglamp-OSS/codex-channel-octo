import { describe, expect, it } from "vitest";
import {
  parseInt64Identity,
  parseMessageIdentity,
  encodeReplyFrame,
  encodeRequestFrame,
  FRAME_PREFIX_BYTES,
  MAX_DIAG_PATH_BYTES,
  MAX_FRAME_BYTES,
  parseCardToolResult,
  parseReplyFrame,
  parseRequestFrame,
  parseStrictJson,
  readFrame,
  type RequestParse,
  type ToolRequestFrame,
} from "../cards/protocol.js";
import type { CardToolResult, DisplayCardArgs, InteractiveCardArgs } from "../cards/contracts.js";

const REQUEST_ID = "0123456789abcdef0123456789abcdef";
const AUTHORITY = "ab".repeat(32);
const enc = new TextEncoder();

function body(value: unknown): Uint8Array {
  return enc.encode(typeof value === "string" ? value : JSON.stringify(value));
}

function request(op: string, args: unknown, extra: Record<string, unknown> = {}): Uint8Array {
  return body({ v: 1, request_id: REQUEST_ID, authority: AUTHORITY, op, args, ...extra });
}

function frameWithLength(length: number, payload = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(FRAME_PREFIX_BYTES + payload.byteLength);
  new DataView(out.buffer).setUint32(0, length, false);
  out.set(payload, FRAME_PREFIX_BYTES);
  return out;
}

function argsRejection(result: RequestParse): { code: string; diagnostics: readonly { path: string; rule: string }[] } {
  if (result.ok || result.stage !== "args") throw new Error(`expected args rejection, got ${JSON.stringify(result)}`);
  return result;
}

const DISPLAY: DisplayCardArgs = {
  title: "Build report",
  blocks: [
    { kind: "heading", text: "Summary", level: 2 },
    { kind: "text", text: "All checks passed." },
    { kind: "rich_text", runs: [{ kind: "strong", text: "Note" }, { kind: "link", label: "Docs", url: "https://example.com/d" }] },
    { kind: "facts", items: [{ label: "Tests", value: "42" }] },
    { kind: "columns", columns: [{ blocks: [{ kind: "text", text: "L" }] }, { blocks: [{ kind: "text", text: "R" }] }] },
    { kind: "table", headers: ["A", "B"], rows: [["1", "2"]] },
    { kind: "link", label: "Run", url: "https://example.com/run" },
    { kind: "group", blocks: [{ kind: "copy", label: "Copy id", text: "abc" }] },
    { kind: "collapsible", label: "Details", blocks: [{ kind: "text", text: "Hidden" }], expanded: false },
  ],
};

const INTERACTIVE: InteractiveCardArgs = {
  title: "Pick a slot",
  text: "Choose one",
  sections: [{ text: "Context" }],
  inputs: [
    { id: "note", kind: "text", label: "Note", required: false, maxLength: 200 },
    { id: "count", kind: "number", label: "Count", required: true, min: 1, max: 9 },
    { id: "day", kind: "date", label: "Day", required: true, timezone: "Asia/Shanghai" },
    { id: "slot", kind: "choice", label: "Slot", required: true, multiple: false, min: 1, max: 1,
      options: [{ id: "am", label: "Morning" }, { id: "pm", label: "Afternoon" }] },
    { id: "ok", kind: "toggle", label: "Confirm", required: false },
  ],
  buttons: [{ id: "submit", label: "Submit", data: { step: 1, tags: ["a", "b"] } }],
};

describe("strict JSON", () => {
  const limits = { maxDepth: 8, maxNodes: 100, unsafeIntegers: "reject" as const };

  it("rejects duplicate and prototype-sensitive keys, lone surrogates and trailing data", () => {
    expect(parseStrictJson('{"a":1,"a":2}', limits)).toEqual({ ok: false, code: "duplicate_key" });
    expect(parseStrictJson('{"__proto__":{}}', limits)).toEqual({ ok: false, code: "forbidden_key" });
    expect(parseStrictJson('{"constructor":1}', limits)).toEqual({ ok: false, code: "forbidden_key" });
    expect(parseStrictJson('"\\ud800"', limits)).toEqual({ ok: false, code: "lone_surrogate" });
    expect(parseStrictJson("{} x", limits)).toEqual({ ok: false, code: "malformed_json" });
    expect(parseStrictJson("[1,]", limits)).toEqual({ ok: false, code: "malformed_json" });
    expect(parseStrictJson("NaN", limits)).toEqual({ ok: false, code: "malformed_json" });
  });

  it("bounds depth and node count", () => {
    expect(parseStrictJson("[".repeat(10) + "]".repeat(10), limits)).toEqual({ ok: false, code: "depth_exceeded" });
    expect(parseStrictJson(JSON.stringify(Array(200).fill(0)), limits)).toEqual({ ok: false, code: "too_many_nodes" });
  });

  it("never loses integer precision: rejects or preserves the exact decimal", () => {
    const big = "9223372036854775807";
    expect(parseStrictJson(`{"id":${big}}`, limits)).toEqual({ ok: false, code: "unsafe_integer" });
    const kept = parseStrictJson(`{"id":${big},"n":3}`, { ...limits, unsafeIntegers: "preserve" });
    expect(kept.ok && kept.value).toEqual({ id: big, n: 3 });
  });

  it("produces null-prototype objects", () => {
    const parsed = parseStrictJson('{"a":{"b":1}}', limits);
    expect(parsed.ok && Object.getPrototypeOf(parsed.value)).toBe(null);
  });

  it("round-trips exactly representable finite author numbers without weakening identities", () => {
    const args: InteractiveCardArgs = {
      title: "Large range",
      inputs: [{ id: "amount", kind: "number", label: "Amount", required: true, min: 1e16, max: 1e16 }],
      buttons: [{ id: "ok", label: "OK", data: { amount: 1e16 } }],
    };
    const encoded = encodeRequestFrame({ v: 1, request_id: REQUEST_ID, authority: AUTHORITY, op: "interactive", args });
    const framed = readFrame(encoded);
    expect(framed.kind).toBe("frame");
    if (framed.kind !== "frame") throw new Error("expected complete frame");
    const parsed = parseRequestFrame(framed.body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.frame.op !== "interactive") throw new Error("expected interactive frame");
    expect(parsed.frame.args).toEqual(args);
    expect(parseInt64Identity(1e16)).toBeNull();
    expect(parseMessageIdentity(1e16)).toBeNull();
    expect(parseStrictJson("9007199254740993", limits)).toEqual({ ok: false, code: "unsafe_integer" });
  });
});

describe("framing", () => {
  it("rejects oversize and empty frames from the prefix alone", () => {
    expect(readFrame(frameWithLength(MAX_FRAME_BYTES - FRAME_PREFIX_BYTES + 1))).toEqual({ kind: "error", code: "frame_too_large" });
    expect(readFrame(frameWithLength(0))).toEqual({ kind: "error", code: "frame_empty" });
    expect(readFrame(new Uint8Array(2))).toEqual({ kind: "incomplete" });
    expect(readFrame(frameWithLength(10, new Uint8Array(3)))).toEqual({ kind: "incomplete" });
  });

  it("caps the frame at 32768 bytes including the prefix", () => {
    const frame: ToolRequestFrame = { v: 1, request_id: REQUEST_ID, authority: AUTHORITY, op: "display", args: DISPLAY };
    const encoded = encodeRequestFrame(frame);
    expect(new DataView(encoded.buffer).getUint32(0, false)).toBe(encoded.byteLength - FRAME_PREFIX_BYTES);
    const read = readFrame(encoded);
    expect(read.kind).toBe("frame");

    const big: ToolRequestFrame = {
      v: 1, request_id: REQUEST_ID, authority: AUTHORITY, op: "display",
      args: { blocks: [{ kind: "text", text: "x".repeat(MAX_FRAME_BYTES) }] },
    };
    expect(() => encodeRequestFrame(big)).toThrow(/frame_too_large/);
  });
});

describe("request frames", () => {
  it("accepts closed display and interactive grammars with exact round-trip", () => {
    for (const [op, args] of [["display", DISPLAY], ["interactive", INTERACTIVE]] as const) {
      const parsed = parseRequestFrame(request(op, args));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.frame.op).toBe(op);
        expect(JSON.parse(JSON.stringify(parsed.frame.args))).toEqual(args);
        expect(Object.isFrozen(parsed.frame.args)).toBe(true);
      }
    }
  });

  it("rejects framing/header faults before any authority handling", () => {
    const cases: [Uint8Array, string][] = [
      [body("{"), "malformed_json"],
      [new Uint8Array([0xff, 0xfe]), "malformed_utf8"],
      [new Uint8Array([0xef, 0xbb, 0xbf, ...body({})]), "malformed_utf8"],
      [body({ v: 1 }), "bad_shape"],
      [request("display", DISPLAY, { extra: 1 }), "bad_shape"],
      [body({ v: 2, request_id: REQUEST_ID, authority: AUTHORITY, op: "display", args: DISPLAY }), "bad_version"],
      [body({ v: 1, request_id: REQUEST_ID.toUpperCase(), authority: AUTHORITY, op: "display", args: DISPLAY }), "bad_request_id"],
      [body({ v: 1, request_id: "abc", authority: AUTHORITY, op: "display", args: DISPLAY }), "bad_request_id"],
      [body({ v: 1, request_id: REQUEST_ID, authority: "ab".repeat(31), op: "display", args: DISPLAY }), "bad_authority"],
      [request("send_message", DISPLAY), "bad_opcode"],
      [request("display", [DISPLAY]), "bad_args"],
      [body('{"v":1,"v":1}'), "duplicate_key"],
    ];
    for (const [input, code] of cases) {
      const parsed = parseRequestFrame(input);
      expect(parsed).toMatchObject({ ok: false, stage: "frame", code });
    }
  });

  it("rejects routing/context/credential keys anywhere, including button data, as invalid_route first", () => {
    const routed = [
      { ...DISPLAY, channel_id: "g1" },
      { ...DISPLAY, blocks: [{ kind: "text", text: "x", thread_id: "t" }] },
      { ...INTERACTIVE, buttons: [{ id: "b", label: "B", data: { nested: { botToken: "x" } } }] },
      { ...INTERACTIVE, buttons: [{ id: "b", label: "B", data: { Account_ID: "a" } }] },
      { ...DISPLAY, onBehalfOf: "u2", unknownThing: 1 },
      { ...DISPLAY, api_origin: "https://evil.example" },
    ];
    for (const args of routed) {
      const op = "buttons" in args ? "interactive" : "display";
      const result = argsRejection(parseRequestFrame(request(op, args)));
      expect(result.code).toBe("invalid_route");
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].rule).toBe("routing_field");
    }
  });

  it("returns the header for args rejections so authentication precedes charging", () => {
    const parsed = parseRequestFrame(request("display", { ...DISPLAY, channel_id: "g1" }));
    expect(parsed).toMatchObject({ ok: false, stage: "args", header: { v: 1, request_id: REQUEST_ID, authority: AUTHORITY, op: "display" } });
  });

  it("rejects HTML keys, markup and credential-shaped values as validation_failed", () => {
    const html = argsRejection(parseRequestFrame(request("display", { blocks: [{ kind: "text", text: "<script>x</script>" }] })));
    expect(html).toMatchObject({ code: "validation_failed", diagnostics: [{ path: "$.blocks[0].text", rule: "html_markup" }] });
    const key = argsRejection(parseRequestFrame(request("display", { blocks: [{ kind: "text", text: "a", innerHTML: "b" }] })));
    expect(key.diagnostics[0]).toEqual({ path: "$.blocks[0].*", rule: "html_forbidden" });
    const cred = argsRejection(parseRequestFrame(request("display", { blocks: [{ kind: "text", text: "Bearer abcdefghijklmnop" }] })));
    expect(cred.diagnostics[0].rule).toBe("credential_value");
    expect(parseRequestFrame(request("display", { blocks: [{ kind: "text", text: "a < b and c > d" }] })).ok).toBe(true);
  });

  it("rejects unknown keys at every object depth with fixed paths that never echo the key", () => {
    const secretKey = "zz_private_marker";
    const variants: [string, unknown][] = [
      ["display", { ...DISPLAY, [secretKey]: 1 }],
      ["display", { blocks: [{ kind: "heading", text: "h", [secretKey]: 1 }] }],
      ["display", { blocks: [{ kind: "rich_text", runs: [{ kind: "code", text: "c", [secretKey]: 1 }] }] }],
      ["display", { blocks: [{ kind: "columns", columns: [{ blocks: [], [secretKey]: 1 }] }] }],
      ["interactive", { ...INTERACTIVE, inputs: [{ id: "a", kind: "toggle", label: "A", required: false, [secretKey]: 1 }] }],
      ["interactive", { ...INTERACTIVE, buttons: [{ id: "b", label: "B", [secretKey]: 1 }] }],
      ["interactive", { ...INTERACTIVE, sections: [{ text: "s", [secretKey]: 1 }] }],
    ];
    for (const [op, args] of variants) {
      const result = argsRejection(parseRequestFrame(request(op, args)));
      expect(result.code).toBe("validation_failed");
      expect(result.diagnostics.some((d) => d.rule === "unknown_field")).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secretKey);
    }
  });

  it("enforces closed kind unions, field types and per-op top-level grammar", () => {
    const cases: [string, unknown, string][] = [
      ["display", { blocks: [{ kind: "image", url: "https://x" }] }, "unknown_kind"],
      ["display", { blocks: [{ kind: "heading", text: "h", level: 4 }] }, "invalid_enum"],
      ["display", { blocks: [{ kind: "text" }] }, "missing_field"],
      ["display", { blocks: [{ kind: "text", text: 5 }] }, "wrong_type"],
      ["display", { blocks: [{ kind: "table", headers: ["a"], rows: [[1]] }] }, "wrong_type"],
      ["display", { title: "t" }, "missing_field"],
      ["display", { blocks: [], buttons: [] }, "unknown_field"],
      ["interactive", { ...INTERACTIVE, inputs: [{ id: "n", kind: "number", label: "N", required: true, min: 1 }] }, "missing_field"],
      ["interactive", { ...INTERACTIVE, inputs: [{ id: "t", kind: "text", label: "T", required: true, maxLength: 1.5 }] }, "wrong_type"],
      ["interactive", { ...INTERACTIVE, inputs: [{ id: "s", kind: "slider", label: "S", required: true }] }, "unknown_kind"],
      ["interactive", { ...INTERACTIVE, buttons: [{ id: "b", label: "B", data: [1] }] }, "wrong_type"],
      ["interactive", { title: "t", blocks: [], buttons: [] }, "unknown_field"],
    ];
    for (const [op, args, rule] of cases) {
      const result = argsRejection(parseRequestFrame(request(op, args)));
      expect(result.code).toBe("validation_failed");
      expect(result.diagnostics.map((d) => d.rule)).toContain(rule);
    }
  });

  it("bounds button data depth, entries and aggregate bytes", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i]));
    const wide = { blob: "y".repeat(2100) };
    const rules = [deep, many, wide].map((data) =>
      argsRejection(parseRequestFrame(request("interactive", { ...INTERACTIVE, buttons: [{ id: "b", label: "B", data }] }))).diagnostics[0].rule);
    expect(rules).toEqual(["data_depth", "data_entries", "data_bytes"]);
    const split = { ...INTERACTIVE, buttons: [1, 2].map((n) => ({ id: `b${n}`, label: "B", data: { blob: "z".repeat(1100) } })) };
    expect(argsRejection(parseRequestFrame(request("interactive", split))).diagnostics[0].rule).toBe("data_bytes");
  });

  it("caps diagnostics at 16", () => {
    const blocks = Array.from({ length: 40 }, () => ({ kind: "text", text: 1 }));
    const result = argsRejection(parseRequestFrame(request("display", { blocks })));
    expect(result.diagnostics.length).toBe(16);
  });
});

describe("reply frames and CardToolResult", () => {
  const sent: CardToolResult = { status: "sent", message_id: "9223372036854775807", route: { kind: "group", ref: "r_1" } };

  it("round-trips closed results", () => {
    for (const result of [
      sent,
      { ...sent, session_id: "s-1" },
      { status: "degraded", message_id: "12", interaction_available: false, reason: "profile_unavailable" },
      { status: "error", error: { code: "limit_exceeded", diagnostics: [{ path: "$", rule: "explicit_card_budget_exhausted" }] } },
    ] as CardToolResult[]) {
      const frame = encodeReplyFrame({ v: 1, request_id: REQUEST_ID, result });
      const read = readFrame(frame);
      expect(read.kind).toBe("frame");
      const parsed = read.kind === "frame" ? parseReplyFrame(read.body) : null;
      expect(parsed).toEqual({ ok: true, frame: { v: 1, request_id: REQUEST_ID, result } });
    }
  });

  it("rejects open or out-of-contract results", () => {
    const bad = [
      { ...sent, extra: 1 },
      { ...sent, message_id: "9223372036854775808" },
      { ...sent, message_id: 12 },
      { ...sent, message_id: "0" },
      { ...sent, message_id: "00" },
      { status: "degraded", message_id: "0", interaction_available: false, reason: "profile_unavailable" },
      { ...sent, route: { kind: "group", ref: "https://x" } },
      { status: "degraded", message_id: "1", interaction_available: true, reason: "profile_unavailable" },
      { status: "error", error: { code: "boom" } },
      { status: "error", error: { code: "unavailable", diagnostics: Array(17).fill({ path: "$", rule: "x" }) } },
      { status: "error", error: { code: "unavailable", diagnostics: [{ path: "$.channel id", rule: "x" }] } },
      { status: "error", error: { code: "unavailable", diagnostics: [{ path: "$", rule: "Has Spaces" }] } },
    ];
    for (const result of bad) {
      expect(parseCardToolResult(JSON.parse(JSON.stringify(result)))).toBeNull();
      expect(() => encodeReplyFrame({ v: 1, request_id: REQUEST_ID, result: result as CardToolResult })).toThrow();
    }
  });
});

describe("identity parsing", () => {
  it("keeps zero valid for cursors but never as a message identity", () => {
    expect(parseInt64Identity("0")).toBe("0");
    expect(parseInt64Identity(0)).toBe("0");
    expect(parseMessageIdentity("0")).toBeNull();
    expect(parseMessageIdentity(0)).toBeNull();
    expect(parseMessageIdentity("9223372036854775807")).toBe("9223372036854775807");
    expect(parseMessageIdentity("9223372036854775808")).toBeNull();
    expect(parseMessageIdentity(9007199254740993)).toBeNull();
    expect(parseMessageIdentity(-1)).toBeNull();
    expect(parseMessageIdentity("01")).toBeNull();
    expect(parseMessageIdentity(42)).toBe("42");
  });
});

describe("nested display diagnostics stay bounded and reply-encodable", () => {
  /** Request-frame JSON depth limit (ARGS_LIMITS.maxDepth); every value, including leaves, counts a level. */
  const ARGS_MAX_JSON_DEPTH = 32;
  const MARKER = "zz_unknown_kind_marker";

  const jsonDepth = (value: unknown): number => {
    if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(jsonDepth));
    if (typeof value === "object" && value !== null) return 1 + Math.max(0, ...Object.values(value).map(jsonDepth));
    return 1;
  };

  const WRAPPERS: Record<string, (inner: unknown) => unknown> = {
    group: (inner) => ({ kind: "group", blocks: [inner] }),
    collapsible: (inner) => ({ kind: "collapsible", label: "More", blocks: [inner] }),
    columns: (inner) => ({ kind: "columns", columns: [{ blocks: [inner] }] }),
  };

  const LEAVES: Record<string, { block: unknown; rule: string }> = {
    malformed_text: { block: { kind: "text", text: 123 }, rule: "wrong_type" },
    missing_text: { block: { kind: "text" }, rule: "missing_field" },
    unknown_block_kind: { block: { kind: MARKER }, rule: "unknown_kind" },
    malformed_rich_run: { block: { kind: "rich_text", runs: [{ kind: "strong", text: 5 }] }, rule: "wrong_type" },
    missing_rich_run_text: { block: { kind: "rich_text", runs: [{ kind: "code" }] }, rule: "missing_field" },
    unknown_rich_run_kind: { block: { kind: "rich_text", runs: [{ kind: MARKER, text: "x" }] }, rule: "unknown_kind" },
    missing_collapsible_label: { block: { kind: "collapsible", blocks: [] }, rule: "missing_field" },
    malformed_collapsible_expanded: { block: { kind: "collapsible", label: "L", blocks: [], expanded: "yes" }, rule: "wrong_type" },
    malformed_columns: { block: { kind: "columns", columns: [{ blocks: 1 }] }, rule: "wrong_type" },
  };

  const nestedArgs = (wrapper: string, levels: number, leaf: unknown): { blocks: unknown[] } => {
    let node = leaf;
    for (let i = 0; i < levels; i++) node = WRAPPERS[wrapper](node);
    return { blocks: [node] };
  };

  const frameDepth = (args: unknown): number => jsonDepth({ v: 1, request_id: REQUEST_ID, authority: AUTHORITY, op: "display", args });

  /** Args rejections must fit the reply grammar and survive an encode/read/parse round trip unchanged. */
  function expectEncodableRejection(parsed: RequestParse, rule: string): void {
    const rejected = argsRejection(parsed);
    expect(rejected.code).toBe("validation_failed");
    expect(rejected.diagnostics.length).toBeGreaterThan(0);
    expect(rejected.diagnostics.map((d) => d.rule)).toContain(rule);
    for (const d of rejected.diagnostics) {
      expect(enc.encode(d.path).byteLength, d.path).toBeLessThanOrEqual(MAX_DIAG_PATH_BYTES);
    }
    expect(JSON.stringify(rejected)).not.toContain(MARKER);

    const result: CardToolResult = {
      status: "error",
      error: { code: "validation_failed", diagnostics: rejected.diagnostics.map((d) => ({ path: d.path, rule: d.rule })) },
    };
    const read = readFrame(encodeReplyFrame({ v: 1, request_id: REQUEST_ID, result }));
    expect(read.kind).toBe("frame");
    if (read.kind !== "frame") throw new Error("expected complete reply frame");
    expect(parseReplyFrame(read.body)).toEqual({ ok: true, frame: { v: 1, request_id: REQUEST_ID, result } });
  }

  function expectFrameDepthRejection(parsed: RequestParse): void {
    expect(parsed).toEqual({ ok: false, stage: "frame", code: "depth_exceeded" });
    expect(parsed).not.toHaveProperty("header");
    expect(parsed).not.toHaveProperty("diagnostics");
  }

  it("twelve nested groups around {kind:'text',text:123} reject at args stage with a bounded, reply-encodable path", () => {
    const args = nestedArgs("group", 12, { kind: "text", text: 123 });
    expect(frameDepth(args)).toBeLessThanOrEqual(ARGS_MAX_JSON_DEPTH);
    const parsed = parseRequestFrame(request("display", args));
    expect(parsed).toMatchObject({ ok: false, stage: "args", header: { v: 1, request_id: REQUEST_ID, authority: AUTHORITY, op: "display" } });
    expectEncodableRejection(parsed, "wrong_type");
  });

  it("fourteen nested groups exceed JSON depth and reject at frame stage without a fabricated header", () => {
    const args = nestedArgs("group", 14, { kind: "text", text: 123 });
    expect(frameDepth(args)).toBeGreaterThan(ARGS_MAX_JSON_DEPTH);
    expectFrameDepthRejection(parseRequestFrame(request("display", args)));
  });

  const LEVELS: Record<string, readonly number[]> = {
    group: [10, 11, 12, 13, 14],
    collapsible: [10, 11, 12, 13, 14],
    // Columns add two JSON levels per wrapper, so the path-length boundary is crossed at 6 and depth at 7-8.
    columns: [5, 6, 7, 8, 10, 11, 12, 13, 14],
  };
  const CASES = Object.entries(LEVELS).flatMap(([wrapper, levels]) =>
    levels.flatMap((level) => Object.keys(LEAVES).map((leaf) => ({ wrapper, level, leaf }))));

  it.each(CASES)("$leaf inside $level nested $wrapper rejects with bounded diagnostics or at frame depth", ({ wrapper, level, leaf }) => {
    const { block, rule } = LEAVES[leaf];
    const args = nestedArgs(wrapper, level, block);
    const parsed = parseRequestFrame(request("display", args));
    if (frameDepth(args) > ARGS_MAX_JSON_DEPTH) {
      expectFrameDepthRejection(parsed);
      return;
    }
    expect(parsed).toMatchObject({ ok: false, stage: "args" });
    expectEncodableRejection(parsed, rule);
  });
});
