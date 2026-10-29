/**
 * Card send/edit acknowledgements against the real Bot API success contract
 * (see fixtures/octo-server-acks.ts). The server never forwards the request's
 * `client_msg_no`, so its echoed value is server-assigned evidence rather than
 * a correlation check; edits succeed with a bare `{"status":200}`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  classifyEditFailure,
  classifySendFailure,
  createCardApi,
  OctoApiError,
  type EditAck,
  type SendAck,
} from "../cards/api.js";
import type { DisplayAdaptiveCard, RegistryData } from "../cards/contracts.js";
import { SERVER_BIG_ID, SERVER_EDIT_ACK, SERVER_GENERATED_CLIENT_MSG_NO, serverSendAck } from "./fixtures/octo-server-acks.js";

const CLIENT = "5f0c6a1e-8a4b-4c7d-9e2f-0123456789ab";
const ROUTE = { channelId: "group_1", channelType: 2 as const };
const REF = { id: "ai.reasoning-process" as const, version: "0.4.0" };
const DATA: RegistryData = {
  reasoningId: "octo-progress",
  state: "reasoning",
  title: "Reasoning",
  statusLabel: "Working",
  statusTone: "Accent",
  timerText: "Reasoning…",
  traceExpanded: true,
  traceCollapsed: false,
  collapsedSummary: "Reasoning in progress · open to follow along",
  progressText: "Working through…",
  phases: [{ thought: "—", actions: [{ tool: "Running command", detail: "git", statusGlyph: "…", statusTone: "Accent" }] }],
};
const CARD: DisplayAdaptiveCard = {
  type: "AdaptiveCard",
  version: "1.5",
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  body: [{ type: "TextBlock", text: "Report", wrap: true }],
};

function client(body: string, status = 200) {
  const fetchImpl = vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  return createCardApi({ apiUrl: "https://api.example.com", credential: "tok", fetchImpl });
}

const SENDS = {
  registry: (body: string): Promise<SendAck> => client(body).sendRegistry({ route: ROUTE, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: DATA }),
  authored: (body: string): Promise<SendAck> => client(body).sendAuthored({ route: ROUTE, clientMsgNo: CLIENT, profile: "octo/v1", card: CARD, plain: "Report" }),
};
const EDITS = {
  registry: (body: string, messageId = SERVER_BIG_ID, seq = 4): Promise<EditAck> => client(body).editRegistry({
    route: ROUTE, messageId, ref: REF, state: "reasoning", data: DATA, seq, transient: true }),
  authored: (body: string, messageId = SERVER_BIG_ID, seq = 4): Promise<EditAck> => client(body).editAuthored({
    route: ROUTE, messageId, profile: "octo/v1", card: CARD, plain: "Report", seq, transient: false }),
};

async function refused(p: Promise<unknown>): Promise<OctoApiError> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(OctoApiError);
  return err as OctoApiError;
}

describe.each(Object.entries(SENDS))("%s send acknowledged by the real server contract", (_name, send) => {
  it("accepts a server-assigned client_msg_no and keeps the int64 message_id lossless", async () => {
    const ack = await send(serverSendAck(SERVER_BIG_ID));
    expect(ack.messageId).toBe(SERVER_BIG_ID);
    expect(ack.clientMsgNo).toBe(CLIENT);
    expect(ack.serverClientMsgNo).toBe(SERVER_GENERATED_CLIENT_MSG_NO);
    expect(ack.messageSeq).toBe(7);
  });

  it("accepts an empty server client_msg_no (absent IM value)", async () => {
    const ack = await send(serverSendAck(SERVER_BIG_ID, ""));
    expect(ack).toMatchObject({ messageId: SERVER_BIG_ID, clientMsgNo: CLIENT, serverClientMsgNo: "" });
  });

  it("still accepts a missing or matching client_msg_no", async () => {
    const missing = await send(`{"message_id":${SERVER_BIG_ID}}`);
    expect(missing.messageId).toBe(SERVER_BIG_ID);
    expect(missing).not.toHaveProperty("serverClientMsgNo");
    const echoed = await send(serverSendAck(SERVER_BIG_ID, CLIENT));
    expect(echoed).toMatchObject({ messageId: SERVER_BIG_ID, clientMsgNo: CLIENT, serverClientMsgNo: CLIENT });
  });

  it.each([
    ["int64 max number", "9223372036854775807", "9223372036854775807"],
    ["2^53 + 1 number", "9007199254740993", "9007199254740993"],
    ["decimal string", `"${SERVER_BIG_ID}"`, SERVER_BIG_ID],
    ["safe number", "42", "42"],
  ])("accepts message_id as %s without Number conversion", async (_n, token, id) => {
    expect((await send(serverSendAck(token))).messageId).toBe(id);
  });

  it.each([
    ["missing", '{"client_msg_no":"x","message_seq":1}'],
    ["zero", serverSendAck("0")],
    ["negative", serverSendAck("-5")],
    ["negative int64", serverSendAck("-9223372036854775001")],
    ["above int64", serverSendAck("9223372036854775808")],
    ["rounded fraction", serverSendAck("9007199254740993.5")],
    ["null", serverSendAck("null")],
    ["object", serverSendAck('{"id":1}')],
    ["array", serverSendAck("[1]")],
    ["boolean", serverSendAck("true")],
    ["non-decimal string", serverSendAck('"0x10"')],
    ["signed string", serverSendAck('"+5"')],
    ["top-level array", "[1]"],
    ["top-level null", "null"],
    ["empty body", ""],
  ])("refuses a %s message_id as an unconfirmed (ambiguous) send", async (_n, body) => {
    const err = await refused(send(body));
    expect(["missing_identity", "malformed_response"]).toContain(err.code);
    expect(classifySendFailure(err)).toBe("ambiguous");
  });

  it.each([
    ["number", `{"message_id":5,"client_msg_no":12}`],
    ["null", `{"message_id":5,"client_msg_no":null}`],
    ["object", `{"message_id":5,"client_msg_no":{"v":"x"}}`],
    ["array", `{"message_id":5,"client_msg_no":["x"]}`],
    ["boolean", `{"message_id":5,"client_msg_no":false}`],
    ["control character", `{"message_id":5,"client_msg_no":"a\\u0000b"}`],
    ["newline", `{"message_id":5,"client_msg_no":"a\\nb"}`],
    ["lone surrogate", `{"message_id":5,"client_msg_no":"a\\ud800b"}`],
    ["oversized", `{"message_id":5,"client_msg_no":"${"x".repeat(257)}"}`],
  ])("refuses a %s client_msg_no as a malformed ack", async (_n, body) => {
    const err = await refused(send(body));
    expect(err.code).toBe("malformed_response");
    expect(classifySendFailure(err)).toBe("ambiguous");
  });

  it.each([
    ["message_id", `{"message_id":5,"message_id":6,"client_msg_no":"x"}`],
    ["client_msg_no", `{"message_id":5,"client_msg_no":"x","client_msg_no":"y"}`],
    ["message_seq", `{"message_id":5,"message_seq":1,"message_seq":2}`],
  ])("refuses a duplicate %s field", async (_n, body) => {
    const err = await refused(send(body));
    expect(err.code).toBe("malformed_response");
    expect(classifySendFailure(err)).toBe("ambiguous");
  });

  it.each(["-1", '"7"', "1.5", "9007199254740993", "null"])("refuses message_seq %s", async (seq) => {
    const err = await refused(send(`{"message_id":5,"client_msg_no":"x","message_seq":${seq}}`));
    expect(err.code).toBe("malformed_response");
    expect(classifySendFailure(err)).toBe("ambiguous");
  });

  it("leaves non-2xx classification unchanged", async () => {
    const at = async (status: number) => classifySendFailure(await refused(
      client("{}", status).sendRegistry({ route: ROUTE, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: DATA })));
    expect(await at(400)).toBe("contract");
    expect(await at(403)).toBe("policy");
    expect(await at(409)).toBe("ambiguous");
    expect(await at(500)).toBe("ambiguous");
  });
});

describe.each(Object.entries(EDITS))("%s edit acknowledged by the real server contract", (_name, edit) => {
  it("accepts the bare {\"status\":200} ack for the requested message and seq", async () => {
    expect(await edit(SERVER_EDIT_ACK)).toMatchObject({ messageId: SERVER_BIG_ID, seq: 4 });
  });

  it("still accepts a matching message_id / card_seq echo, with or without status", async () => {
    expect(await edit(`{"message_id":${SERVER_BIG_ID}}`)).toMatchObject({ messageId: SERVER_BIG_ID, seq: 4 });
    expect(await edit(`{"status":200,"message_id":${SERVER_BIG_ID},"card_seq":4}`)).toMatchObject({ messageId: SERVER_BIG_ID, seq: 4 });
  });

  it.each([
    ["empty object", "{}"],
    ["empty body", ""],
    ["string status", '{"status":"200"}'],
    ["other 2xx status", '{"status":201}'],
    ["error status", '{"status":500}'],
    ["fractional status", '{"status":200.5}'],
    ["null status", '{"status":null}'],
    ["array", "[200]"],
  ])("does not acknowledge %s", async (_n, body) => {
    const err = await refused(edit(body));
    expect(["missing_identity", "malformed_response"]).toContain(err.code);
    expect(classifyEditFailure(err)).toBe("retryable");
  });

  it.each([
    ["foreign message_id", '{"status":200,"message_id":"6"}'],
    ["foreign card_seq", '{"status":200,"card_seq":3}'],
    ["foreign card_seq without status", `{"message_id":${SERVER_BIG_ID},"card_seq":5}`],
  ])("rejects a %s", async (_n, body) => {
    const err = await refused(edit(body));
    expect(err.code).toBe("identity_mismatch");
    expect(classifyEditFailure(err)).toBe("retryable");
  });

  it.each([
    ["zero message_id", '{"status":200,"message_id":0}'],
    ["rounded message_id", '{"status":200,"message_id":9007199254740993.5}'],
    ["object message_id", '{"status":200,"message_id":{}}'],
  ])("rejects a malformed %s even beside status 200", async (_n, body) => {
    const err = await refused(edit(body));
    expect(["missing_identity", "malformed_response"]).toContain(err.code);
    expect(classifyEditFailure(err)).toBe("retryable");
  });

  it("refuses a duplicate status field", async () => {
    const err = await refused(edit('{"status":200,"status":200}'));
    expect(err.code).toBe("malformed_response");
  });
});
