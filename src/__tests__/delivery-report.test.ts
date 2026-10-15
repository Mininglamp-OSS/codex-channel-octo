import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamRelay } from "../stream-relay.js";
import type { DeliveryReport } from "../cards/contracts.js";

const state = vi.hoisted(() => ({ uuid: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...await original<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++state.uuid).padStart(12, "0")}`,
}));

interface RequestBody {
  channel_id: string;
  channel_type: number;
  payload: { type: number; content: string };
  client_msg_no: string;
}
type Reply = (body: RequestBody, index: number) => Response;
let requests: string[];
let reply: Reply;
const parts = ["A".repeat(3500), "B".repeat(3500), "C".repeat(27)];

function confirmed(body: RequestBody, index: number): Response {
  return Response.json({ message_id: `message-${index + 1}`, client_msg_no: body.client_msg_no });
}
async function* chunks(text: string): AsyncIterable<string> { yield text; }
async function deliver(text: string): Promise<DeliveryReport> {
  return new StreamRelay().deliver("fixture-direct", 1, chunks(text), "https://fixture.invalid", "synthetic-placeholder");
}
function assertAttempts(expected: string[]): void {
  expect(requests).toEqual(expected.map((content, index) => JSON.stringify({
    channel_id: "fixture-direct", channel_type: 1, payload: { type: 1, content },
    client_msg_no: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  })));
  expect(vi.getTimerCount()).toBe(0);
}
function assertReport(report: DeliveryReport, expected: number, ids: string[]): void {
  expect(report).toEqual({ expected, acked: ids.length, failed: expected - ids.length, messageIds: ids, emptyNotice: false });
  expect(report.expected).toBe(report.acked + report.failed);
  expect(new Set(report.messageIds).size).toBe(report.messageIds.length);
}

beforeEach(() => {
  state.uuid = 0; requests = []; reply = confirmed;
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    if (new URL(input).pathname === "/v1/bot/typing") return Response.json({});
    const raw = String(init.body);
    const index = requests.length; requests.push(raw);
    return reply(JSON.parse(raw) as RequestBody, index);
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("correlated delivery report", () => {
  it.each(["Answer Ω😀.", parts.join("")])("acknowledges every usable correlated identity", async text => {
    const expectedParts = text === parts.join("") ? parts : [text];
    assertReport(await deliver(text), expectedParts.length, expectedParts.map((_, i) => `message-${i + 1}`));
    assertAttempts(expectedParts);
  });
  it.each([{ failed: [0] }, { failed: [1] }, { failed: [2] }, { failed: [0, 1, 2] }])("continues once after failed segment(s) $failed", async ({ failed }) => {
    reply = (body, i) => failed.includes(i) ? new Response("synthetic outage", { status: 503 }) : confirmed(body, i);
    assertReport(await deliver(parts.join("")), 3, parts.flatMap((_, i) => failed.includes(i) ? [] : [`message-${i + 1}`]));
    assertAttempts(parts);
  });
  const invalid: [string, (body: RequestBody) => unknown][] = [
    ["missing", b => ({ client_msg_no: b.client_msg_no })],
    ["empty", b => ({ message_id: "", client_msg_no: b.client_msg_no })],
    ["whitespace", b => ({ message_id: "   ", client_msg_no: b.client_msg_no })],
    ["null", b => ({ message_id: null, client_msg_no: b.client_msg_no })],
    ["object", b => ({ message_id: {}, client_msg_no: b.client_msg_no })],
    ["number", b => ({ message_id: 7, client_msg_no: b.client_msg_no })],
    ["unsafe number", b => ({ message_id: 1.25e20, client_msg_no: b.client_msg_no })],
    ["out-of-range int64 string", b => ({ message_id: "9223372036854775808", client_msg_no: b.client_msg_no })],
    ["zero int64 string", b => ({ message_id: "0", client_msg_no: b.client_msg_no })],
    ["negative int64 string", b => ({ message_id: "-1234567890123456789", client_msg_no: b.client_msg_no })],
    ["boolean", b => ({ message_id: true, client_msg_no: b.client_msg_no })],
    ["mismatch", () => ({ message_id: "message", client_msg_no: "other-request" })],
    ["missing correlation", () => ({ message_id: "message" })],
    ["null result", () => null],
    ["array result", () => []],
  ];
  it.each(invalid)("counts %s as unconfirmed", async (_, value) => {
    reply = b => Response.json(value(b));
    assertReport(await deliver(parts.join("")), 3, []);
    assertAttempts(parts);
  });
  it.each(["", "{invalid JSON"])("continues after empty or malformed response %j", async raw => {
    reply = (b, i) => i === 1 ? new Response(raw) : confirmed(b, i);
    assertReport(await deliver(parts.join("")), 3, ["message-1", "message-3"]);
    assertAttempts(parts);
  });
  it.each(["1234567890123456789", "9223372036854775807"])("preserves numeric int64 %s exactly", async id => {
    reply = b => new Response(`{"message_id":${id},"client_msg_no":"${b.client_msg_no}"}`);
    assertReport(await deliver("Answer."), 1, [id]);
    assertAttempts(["Answer."]);
  });
  it("preserves opaque string identities without rewriting them", async () => {
    reply = b => Response.json({ message_id: "opaque-message_1", client_msg_no: b.client_msg_no });
    assertReport(await deliver("Answer."), 1, ["opaque-message_1"]);
    assertAttempts(["Answer."]);
  });
  it("does not acknowledge duplicate transport identities for later segments", async () => {
    reply = b => Response.json({ message_id: "same-message", client_msg_no: b.client_msg_no });
    assertReport(await deliver(parts.join("")), 3, ["same-message"]);
    assertAttempts(parts);
  });

  const unusableIds: unknown[] = [
    "0", "-1", "+0", "+1", "01", "001", "0000000000000001", "01234567890123456789",
    " 1", "1 ", "\t1", "1\n", " 0 ", " message-1", "message-1 ", "message id",
    "1.0", "0.1", ".1", "1e0", "1E+3", "1e-3", "-0", "0x1", "1_000",
    "9223372036854775808", "9999999999999999999999999999999999999999",
    "", " ", "\0", "\u0001", "\u001f", "\u007f", "\u0080", "\u009f", "id\0tail",
    "id\u0085tail", "\ud800", "\udc00", "id\ud800tail", "id\udc00tail", "message-Ω", "id😀",
    "NaN", "Infinity", "-Infinity", "１２", "١", "id/part", "id.part", "id:part",
    "a".repeat(129), null, {}, [], 1, 0, -1, true,
    ...Array.from({ length: 32 }, (_, code) => `id${String.fromCharCode(code)}tail`),
    ...Array.from({ length: 33 }, (_, code) => `id${String.fromCharCode(127 + code)}tail`),
    "id\u2028tail", "id\u2029tail", "id\u200btail", "id\u202etail", "id\ufeff",
    "\u00a01", "1\u00a0", "01e0", "1abc", "--1", "+", ".",
  ];
  it.each(unusableIds.map(id => [id]))("rejects noncanonical or unbounded string identity %j", async id => {
    reply = b => Response.json({ message_id: id, client_msg_no: b.client_msg_no });
    assertReport(await deliver(parts.join("")), 3, []);
    assertAttempts(parts);
  });
  it.each(["1", "9223372036854775807", "message-1", "opaque_message-2", "a".repeat(128),
    "00000000-0000-4000-8000-000000000001"])("preserves bounded canonical identity %s", async id => {
    reply = b => Response.json({ message_id: id, client_msg_no: b.client_msg_no });
    assertReport(await deliver("Answer."), 1, [id]);
    assertAttempts(["Answer."]);
  });
  // Reviewer regressions: inherited int64 protection recovers these invalid
  // JSON tokens as strings. They must never become acknowledgement evidence.
  it.each(["0000000000000001", "01234567890123456789", "01", "001", "+0", "+1", "-1",
    "0", "1.0", "1e0", "9223372036854775808"])("rejects raw numeric token %s", async rawId => {
    reply = b => new Response(`{"message_id":${rawId},"client_msg_no":"${b.client_msg_no}"}`, { status: 200 });
    assertReport(await deliver(parts.join("")), 3, []);
    assertAttempts(parts);
  });
  it.each([["1", "01", "001"], ["01", "1", "001"], ["1", "1", "1"],
    ["9223372036854775807", "09223372036854775807", "9223372036854775807"]])(
    "rejects exact duplicates and numeric aliases across correlated sends %j/%j/%j", async (...ids) => {
      reply = (b, i) => Response.json({ message_id: ids[i], client_msg_no: b.client_msg_no });
      const expected = ids.includes("1") ? ["1"] : ["9223372036854775807"];
      assertReport(await deliver(parts.join("")), 3, expected);
      assertAttempts(parts);
    });
  it.each([undefined, null, 1, "", "other-request"])("keeps correlation mandatory for valid IDs (%j)", async correlation => {
    reply = () => Response.json({ message_id: "1", client_msg_no: correlation });
    assertReport(await deliver(parts.join("")), 3, []);
    assertAttempts(parts);
  });
  it("orders confirmed IDs around a rejected numeric alias", async () => {
    const ids = ["1", "01", "2"];
    reply = (b, i) => Response.json({ message_id: ids[i], client_msg_no: b.client_msg_no });
    assertReport(await deliver(parts.join("")), 3, ["1", "2"]);
    assertAttempts(parts);
  });
  it.each(["nan", "NAN", "Nan", "nAN", "NaN", "infinity", "INFINITY", "iNfInItY", "Infinity", "inf", "INF", "Inf"])(
    "rejects whole-token reserved identity %s regardless of case", async id => {
      reply = b => Response.json({ message_id: id, client_msg_no: b.client_msg_no });
      assertReport(await deliver(parts.join("")), 3, []);
      assertAttempts(parts);
    });
  it.each(["_nan", "nan_", "nan1", "NaNa", "naN-x", "Infinity-1", "inf1"])(
    "retains legitimate opaque identity %s", async id => {
      reply = b => Response.json({ message_id: id, client_msg_no: b.client_msg_no });
      assertReport(await deliver("Answer."), 1, [id]);
      assertAttempts(["Answer."]);
    });
  it.each([["Msg_a", "msg_A", "Msg_a"], ["msg_A", "Msg_a", "msg_A"]])(
    "keeps opaque case aliases distinct and exact duplicates unconfirmed %j/%j/%j", async (...ids) => {
      reply = (b, i) => Response.json({ message_id: ids[i], client_msg_no: b.client_msg_no });
      assertReport(await deliver(parts.join("")), 3, ids.slice(0, 2));
      assertAttempts(parts);
    });
  const uuidSpellings = ["12345678", "abcdef12"].map(prefix => [
    `${prefix}-abcd-4abc-8abc-123456789abc`,
    `${prefix}-AbCd-4aBc-8AbC-123456789aBc`,
    `${prefix}-aBcD-4AbC-8aBc-123456789AbC`,
    `${prefix}-ABcd-4ABc-8abC-123456789ABc`,
    `${prefix.toUpperCase()}-ABCD-4ABC-8ABC-123456789ABC`,
  ]);
  it.each(uuidSpellings.flatMap(ids => [{ ids }, { ids: [...ids].reverse() }]))(
    "deduplicates UUID semantic aliases, preserving the first spelling: $ids", async ({ ids }) => {
      const segments = ids.map(() => "X".repeat(3500));
      reply = (b, i) => Response.json({ message_id: ids[i], client_msg_no: b.client_msg_no });
      assertReport(await deliver(segments.join("")), ids.length, [ids[0]!]);
      assertAttempts(segments);
    });
  it.each(uuidSpellings.map(ids => ({ ids })))(
    "retains confirmation order around UUID aliases: $ids", async ({ ids }) => {
      const returned = [ids[1]!, "Msg_a", ids[4]!];
      reply = (b, i) => Response.json({ message_id: returned[i], client_msg_no: b.client_msg_no });
      assertReport(await deliver(parts.join("")), 3, returned.slice(0, 2));
      assertAttempts(parts);
    });
  it("does not reserve a UUID key for an uncorrelated response", async () => {
    const ids = uuidSpellings[0]!;
    reply = (b, i) => Response.json({ message_id: ids[i], client_msg_no: i === 0 ? "other-request" : b.client_msg_no });
    assertReport(await deliver(parts.join("")), 3, [ids[1]!]);
    assertAttempts(parts);
  });
  it("keeps legitimate empty output separate from an acknowledged empty notice", async () => {
    assertReport(await deliver(""), 0, []);
    assertAttempts([]);
  });
  it("flushes partial text despite concurrent delivery failure and rethrows the original object", async () => {
    const error = new Error("Synthetic iterator failure");
    reply = (b, i) => i === 1 ? new Response("synthetic outage", { status: 503 }) : confirmed(b, i);
    const stream = (async function* () { yield parts.join(""); throw error; })();
    await expect(new StreamRelay().deliver("fixture-direct", 1, stream, "https://fixture.invalid", "synthetic-placeholder")).rejects.toBe(error);
    assertAttempts(parts);
  });
});
