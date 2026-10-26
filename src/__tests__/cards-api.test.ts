/**
 * Card REST boundary with an injected fetch double. These fixtures prove
 * client behavior only; they establish no live server fact (P01–P10).
 */
import { describe, expect, it, vi } from "vitest";
import {
  CardRequestError,
  classifyEditFailure,
  classifyProfileFailure,
  classifySendFailure,
  createCardApi,
  OctoApiError,
  parseRetryAfter,
  serializeEditAuthored,
  serializeEditRegistry,
  serializeSendAuthored,
  serializeSendRegistry,
  projectCardProfile,
  type CardApiConfig,
} from "../cards/api.js";
import type { DisplayAdaptiveCard, InteractiveAdaptiveCard, RegistryData } from "../cards/contracts.js";

const TOKEN = "tok_SECRET_123";
const CLIENT = "5f0c6a1e-8a4b-4c7d-9e2f-0123456789ab";
const ROUTE = { channelId: "group_1", channelType: 2 as const };
const REF = { id: "ai.reasoning-process" as const, version: "0.4.0" };
const BIG_ID = "9223372036854775806";

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

const DISPLAY_CARD: DisplayAdaptiveCard = {
  type: "AdaptiveCard",
  version: "1.5",
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  body: [
    { type: "TextBlock", text: "Report", wrap: true, weight: "Bolder", size: "Medium" },
    { type: "FactSet", facts: [{ title: "Tests", value: "42" }] },
    { type: "ActionSet", actions: [{ type: "Action.OpenUrl", title: "Open", url: "https://example.com/r" }] },
  ],
};

const INTERACTIVE_CARD: InteractiveAdaptiveCard = {
  type: "AdaptiveCard",
  version: "1.5",
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  body: [
    { type: "TextBlock", text: "Pick", wrap: true, weight: "Bolder", size: "Medium" },
    { type: "Input.ChoiceSet", id: "slot", label: "Slot", style: "expanded", choices: [{ title: "AM", value: "am" }] },
  ],
  actions: [{ type: "Action.Submit", id: "go", title: "Go", data: { step: 1 } }],
};

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function api(handler: Handler, extra: Partial<CardApiConfig> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return { client: createCardApi({ apiUrl: "https://api.example.com/base/", credential: TOKEN, fetchImpl, ...extra }), calls };
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), { status, headers });
}

async function failure(p: Promise<unknown>): Promise<OctoApiError | CardRequestError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof OctoApiError || err instanceof CardRequestError) return err;
    throw err;
  }
  throw new Error("expected failure");
}

describe("wire serialization", () => {
  it("serializes the Registry send envelope byte-stably in reference key order", () => {
    const req = serializeSendRegistry({ route: ROUTE, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: DATA });
    expect(req.path).toBe("/v1/bot/sendMessage");
    expect(Object.keys(JSON.parse(req.body))).toEqual(["channel_id", "channel_type", "payload", "client_msg_no"]);
    expect(JSON.parse(req.body).payload).toEqual({ type: 17, template_ref: REF, state: "reasoning", data: DATA });
    expect(serializeSendRegistry({ route: ROUTE, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: DATA }).body).toBe(req.body);
    expect(req.bytes).toBe(new TextEncoder().encode(req.body).byteLength);
  });

  it("serializes Registry edits with top-level card_seq and transient only when true", () => {
    const base = { route: ROUTE, messageId: BIG_ID, ref: REF, state: "reasoning" as const, data: DATA, seq: 3 };
    const t = JSON.parse(serializeEditRegistry({ ...base, transient: true }).body);
    expect(Object.keys(t)).toEqual(["message_id", "channel_id", "channel_type", "template_ref", "state", "data", "card_seq", "transient"]);
    expect(t.message_id).toBe(BIG_ID);
    const terminal = JSON.parse(serializeEditRegistry({ ...base, state: "completed", data: { ...DATA, state: "completed" }, transient: false }).body);
    expect("transient" in terminal).toBe(false);
  });

  it("serializes authored sends as Adaptive Card payloads and edits as an exact content_edit string", () => {
    const send = JSON.parse(serializeSendAuthored({ route: ROUTE, clientMsgNo: CLIENT, profile: "octo/v1", card: DISPLAY_CARD, plain: "Report" }).body);
    expect(send.payload).toEqual({ type: 17, card: DISPLAY_CARD, profile: "octo/v1", card_version: "1.5", plain: "Report" });

    const edit = JSON.parse(serializeEditAuthored({
      route: ROUTE, messageId: "77", profile: "octo/v2", card: INTERACTIVE_CARD, plain: "Pick", seq: 2, transient: true,
    }).body);
    expect(Object.keys(edit)).toEqual(["message_id", "channel_id", "channel_type", "content_edit"]);
    expect(typeof edit.content_edit).toBe("string");
    expect(JSON.parse(edit.content_edit)).toEqual({
      type: 17, card: INTERACTIVE_CARD, profile: "octo/v2", card_version: "1.5", plain: "Pick", card_seq: 2, transient: true,
    });
    expect(Object.keys(JSON.parse(edit.content_edit))).toEqual(["type", "card", "profile", "card_version", "plain", "card_seq", "transient"]);
    const again = JSON.parse(serializeEditAuthored({
      route: ROUTE, messageId: "77", profile: "octo/v2", card: INTERACTIVE_CARD, plain: "Pick", seq: 2, transient: true,
    }).body);
    expect(again.content_edit).toBe(edit.content_edit);
  });

  it("drops undeclared runtime keys and rejects off-contract card bodies before transport", () => {
    const sneaky = { ...DISPLAY_CARD, body: [{ type: "TextBlock", text: "x", wrap: true, onclick: "evil()" }] } as unknown as DisplayAdaptiveCard;
    const out = JSON.parse(serializeSendAuthored({ route: ROUTE, clientMsgNo: CLIENT, profile: "octo/v1", card: sneaky, plain: "x" }).body);
    expect(out.payload.card.body[0]).toEqual({ type: "TextBlock", text: "x", wrap: true });

    const bad: unknown[] = [
      { ...DISPLAY_CARD, version: "1.6" },
      { ...DISPLAY_CARD, body: [{ type: "Image", url: "https://x" }] },
      { ...DISPLAY_CARD, body: [{ type: "Input.Text", id: "a" }] },
      { ...DISPLAY_CARD, actions: [{ type: "Action.Submit", id: "a", title: "A" }] },
      { ...DISPLAY_CARD, body: [{ type: "ActionSet", actions: [{ type: "Action.OpenUrl", title: "x", url: "javascript:alert(1)" }] }] },
      { ...DISPLAY_CARD, body: [{ type: "ActionSet", actions: [{ type: "Action.OpenUrl", title: "x", url: "https://u:p@example.com" }] }] },
    ];
    for (const card of bad) {
      expect(() => serializeSendAuthored({ route: ROUTE, clientMsgNo: CLIENT, profile: "octo/v1", card: card as DisplayAdaptiveCard, plain: "x" }))
        .toThrow(CardRequestError);
    }
  });

  it("validates Registry data against the template contract bounds", () => {
    const send = (state: "reasoning" | "error", data: unknown) => () =>
      serializeSendRegistry({ route: ROUTE, clientMsgNo: CLIENT, ref: REF, state, data: data as RegistryData });
    expect(send("error", DATA)).toThrow(/data\.state/);
    expect(send("reasoning", { ...DATA, statusTone: "Red" })).toThrow(CardRequestError);
    expect(send("reasoning", { ...DATA, timerText: "t".repeat(129) })).toThrow(/timerText/);
    expect(send("reasoning", { ...DATA, phases: [{ thought: "x".repeat(282), actions: DATA.phases[0].actions }] })).toThrow(/thought/);
    expect(send("reasoning", { ...DATA, phases: Array(7).fill(DATA.phases[0]) })).toThrow(/phases/);
    expect(send("reasoning", { ...DATA, phases: [{ thought: "t", actions: Array(13).fill(DATA.phases[0].actions[0]) }] })).toThrow(/phases/);
  });

  it("rejects malformed membership identifiers with a typed error before transport", async () => {
    let calls = 0;
    const api = createCardApi({
      apiUrl: "https://api.example.com",
      credential: "fixture-token",
      fetchImpl: async () => { calls++; return json(200, { members: [] }); },
    });
    for (const groupNo of ["\ud800", "\udc00"]) {
      const err = await failure(api.getFreshMembers(groupNo));
      expect(err).toBeInstanceOf(CardRequestError);
      expect(err.message).toBe("card api request rejected: invalid_request (group_no)");
    }
    expect(calls).toBe(0);
  });

  it.each([".", ".."])("rejects dot-segment membership identifier %j as invalid_request before transport", async (groupNo) => {
    const { client, calls } = api(() => json(200, { members: [{ uid: "u1" }] }));
    const err = await failure(client.getFreshMembers(groupNo));
    expect(err).toBeInstanceOf(CardRequestError);
    expect(err).toMatchObject({ code: "invalid_request", field: "group_no" });
    expect(err.message).toBe("card api request rejected: invalid_request (group_no)");
    expect(calls).toHaveLength(0);
  });

  it("encodes ordinary membership identifiers including slash, spaces, Unicode and literal %2e as one segment", async () => {
    const cases: [string, string][] = [
      ["grp/1", "grp%2F1"],
      ["team alpha", "team%20alpha"],
      ["研发 组", "%E7%A0%94%E5%8F%91%20%E7%BB%84"],
      ["équipe", "%C3%A9quipe"],
      ["%2e", "%252e"],
      ["%2e%2e", "%252e%252e"],
    ];
    const { client, calls } = api(() => json(200, { members: [{ uid: "u1" }] }));
    for (const [groupNo, segment] of cases) {
      expect(await client.getFreshMembers(groupNo)).toEqual([{ uid: "u1" }]);
      expect(calls.at(-1)?.url).toBe(`https://api.example.com/base/v1/bot/groups/${segment}/members`);
    }
    expect(calls).toHaveLength(cases.length);
  });

  it("rejects invalid routes, identities and oversized envelopes before transport", () => {
    expect(() => serializeSendRegistry({ route: { channelId: "", channelType: 2 }, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: DATA })).toThrow(/channel_id/);
    expect(() => serializeSendRegistry({ route: { channelId: "g", channelType: 3 as 2 }, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: DATA })).toThrow(/channel_type/);
    expect(() => serializeSendRegistry({ route: ROUTE, clientMsgNo: "not-a-uuid", ref: REF, state: "reasoning", data: DATA })).toThrow(/client_msg_no/);
    expect(() => serializeEditRegistry({ route: ROUTE, messageId: "9223372036854775808", ref: REF, state: "reasoning", data: DATA, seq: 1, transient: true })).toThrow(/message_id/);
    expect(() => serializeEditRegistry({ route: ROUTE, messageId: "1", ref: REF, state: "reasoning", data: DATA, seq: 0, transient: true })).toThrow(/card_seq/);
    const huge = { ...DISPLAY_CARD, body: [{ type: "TextBlock" as const, text: "x".repeat(17_000), wrap: true as const }] };
    expect(() => serializeSendAuthored({ route: ROUTE, clientMsgNo: CLIENT, profile: "octo/v1", card: huge, plain: "x" })).toThrow(/envelope_too_large/);
    expect(() => serializeSendAuthored({ route: ROUTE, clientMsgNo: CLIENT, profile: "octo/v1", card: DISPLAY_CARD, plain: "x", maxEnvelopeBytes: 64 })).toThrow(/envelope_too_large/);
  });
});

describe("client transport", () => {
  it("uses only the trusted base and bearer credential and parses a lossless int64 identity", async () => {
    const { client, calls } = api(() => json(200, `{"message_id":${BIG_ID},"client_msg_no":"${CLIENT}","message_seq":5}`));
    const ack = await client.sendRegistry({ route: ROUTE, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: DATA });
    expect(ack.messageId).toBe(BIG_ID);
    expect(ack.messageSeq).toBe(5);
    expect(calls[0].url).toBe("https://api.example.com/base/v1/bot/sendMessage");
    expect(calls[0].init.redirect).toBe("manual");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].init.body).toBe(ack.request.body);
  });

  it("treats 2xx without identity or with a foreign client id as an unconfirmed send", async () => {
    for (const body of ["", "{}", '{"message_id":"abc"}', "[1]", `{"message_id":1,"client_msg_no":"other"}`, "not json"]) {
      const { client } = api(() => json(200, body));
      const err = await failure(client.sendRegistry({ route: ROUTE, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: DATA }));
      expect(err).toBeInstanceOf(OctoApiError);
      expect(classifySendFailure(err)).toBe("ambiguous");
    }
  });

  it("classifies send, edit and profile failures per §5.3", async () => {
    const send = async (status: number) => {
      const { client } = api(() => json(status, { error: "x" }));
      return failure(client.sendRegistry({ route: ROUTE, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: DATA }));
    };
    const edit = async (status: number) => {
      const { client } = api(() => json(status, {}));
      return failure(client.editRegistry({ route: ROUTE, messageId: "5", ref: REF, state: "reasoning", data: DATA, seq: 2, transient: true }));
    };
    const profile = async (status: number) => {
      const { client } = api(() => json(status, {}));
      return failure(client.getProfile());
    };
    const sendClasses = await Promise.all([429, 500, 503, 409, 400, 422, 404, 401, 403].map(async (s) => classifySendFailure(await send(s))));
    expect(sendClasses).toEqual(["ambiguous", "ambiguous", "ambiguous", "ambiguous", "contract", "contract", "contract", "policy", "policy"]);
    const editClasses = await Promise.all([200, 429, 502, 400, 409, 401, 404].map(async (s) => classifyEditFailure(await edit(s))));
    expect(editClasses).toEqual(["retryable", "retryable", "retryable", "contract", "contract", "policy", "gone"]);
    const profileClasses = await Promise.all([404, 401, 400, 429, 500].map(async (s) => classifyProfileFailure(await profile(s))));
    expect(profileClasses).toEqual([
      { category: "disabled", reason: "profile_404", cache: true },
      { category: "disabled", reason: "auth", cache: true },
      { category: "disabled", reason: "malformed", cache: true },
      { category: "unavailable", cache: false },
      { category: "unavailable", cache: false },
    ]);
  });

  it("reports stale only for an explicitly configured proven rejection code", async () => {
    const reply = () => json(409, { code: "card_seq_stale" });
    const req = { route: ROUTE, messageId: "5", ref: REF, state: "reasoning" as const, data: DATA, seq: 2, transient: true };
    const unconfigured = await failure(api(reply).client.editRegistry(req));
    expect(classifyEditFailure(unconfigured)).toBe("contract");
    const configured = await failure(api(reply, { staleSequence: { status: 409, field: "code", value: "card_seq_stale" } }).client.editRegistry(req));
    expect((configured as OctoApiError).code).toBe("stale_sequence");
    expect(classifyEditFailure(configured)).toBe("stale");
  });

  it("acknowledges edits only for the edited identity", async () => {
    const req = { route: ROUTE, messageId: BIG_ID, ref: REF, state: "reasoning" as const, data: DATA, seq: 4, transient: true };
    expect((await api(() => json(200, `{"message_id":${BIG_ID},"card_seq":4}`)).client.editRegistry(req)).seq).toBe(4);
    const other = await failure(api(() => json(200, { message_id: "1" })).client.editRegistry(req));
    expect((other as OctoApiError).code).toBe("identity_mismatch");
    const seq = await failure(api(() => json(200, `{"message_id":${BIG_ID},"card_seq":3}`)).client.editRegistry(req));
    expect((seq as OctoApiError).code).toBe("identity_mismatch");
  });

  it("refuses redirects without following them and never exposes the response", async () => {
    const { client, calls } = api(() => new Response("leak", { status: 302, headers: { location: "https://evil.example/x" } }));
    const err = await failure(client.getProfile());
    expect(err).toMatchObject({ transport: "response", status: 302, code: "redirect_refused" });
    expect(calls).toHaveLength(1);
    expect(classifySendFailure(err)).toBe("ambiguous");
  });

  it("refuses a response whose final URL left the configured origin", async () => {
    const res = json(200, { message_id: "1" });
    Object.defineProperty(res, "url", { value: "https://evil.example/v1/bot/sendMessage" });
    const err = await failure(api(() => res).client.sendRegistry({ route: ROUTE, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: DATA }));
    expect((err as OctoApiError).code).toBe("redirect_refused");
  });

  it("bounds body reads by declared length and by streamed bytes", async () => {
    const declared = await failure(api(() => new Response("{}", { status: 200, headers: { "content-length": "999999999" } })).client.getProfile());
    expect((declared as OctoApiError).code).toBe("response_too_large");
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(32 * 1024).fill(0x20));
        if (pulled > 1000) controller.close();
      },
    });
    const streamed = await failure(api(() => new Response(stream, { status: 200 })).client.getProfile());
    expect((streamed as OctoApiError).code).toBe("response_too_large");
    expect(pulled).toBeLessThan(10);
  });

  it("maps network, deadline and external abort to typed content-free errors", async () => {
    const network = await failure(api(() => { throw new TypeError(`connect ECONNREFUSED ${TOKEN}`); }).client.getProfile());
    expect(network).toMatchObject({ transport: "network", status: 0, code: "network" });
    expect(network.message).not.toContain(TOKEN);
    expect((network as Error).cause).toBeUndefined();

    const hang: Handler = (_url, init) => new Promise((_, rejectFn) => {
      init.signal?.addEventListener("abort", () => rejectFn(new DOMException("aborted", "AbortError")));
    });
    const timeout = await failure(api(hang).client.getProfile({ deadlineMs: 20 }));
    expect(timeout).toMatchObject({ transport: "timeout", code: "timeout" });
    expect(classifySendFailure(timeout)).toBe("ambiguous");
    expect(classifyEditFailure(timeout)).toBe("retryable");

    const controller = new AbortController();
    const pending = failure(api(hang).client.getProfile({ signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({ transport: "abort", code: "aborted" });

    const pre = new AbortController();
    pre.abort();
    const { client, calls } = api(() => json(200, {}));
    expect(await failure(client.getProfile({ signal: pre.signal }))).toMatchObject({ transport: "abort" });
    expect(calls).toHaveLength(0);
    expect(await failure(client.getProfile({ deadlineMs: 0 }))).toBeInstanceOf(CardRequestError);
  });

  it("removes its abort listener and timer after completion", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await api(() => json(200, {})).client.getProfile({ signal: controller.signal });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
  });

  it("parses Retry-After deltas and HTTP dates", async () => {
    const now = Date.parse("Wed, 14 Oct 2026 00:00:00 GMT");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Wed, 14 Oct 2026 00:15:00 GMT", now)).toBe(900_000);
    expect(parseRetryAfter("Tue, 13 Oct 2026 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
    const err = await failure(api(() => json(429, {}, { "retry-after": "900" })).client.getProfile());
    expect(err).toMatchObject({ status: 429, retryAfterMs: 900_000 });
  });

  it("returns the profile only as a strictly parsed bounded object", async () => {
    const profile = { available: true, config: { card_enabled: true, display_enabled: true, interaction_enabled: false, reasoning_enabled: false, reasoning_template_ref: null } };
    expect(await api(() => json(200, profile)).client.getProfile()).toEqual(profile);
    for (const body of ['{"a":1,"a":2}', "[]", "", '{"limits":{"max_nodes":9007199254740993}}']) {
      const err = await failure(api(() => json(200, body)).client.getProfile());
      expect(classifyProfileFailure(err)).toEqual({ category: "unavailable", cache: false });
    }
  });

  it("polls events with the reference request shape and validates envelopes", async () => {
    const { client, calls } = api(() => json(200, { results: [{ event_id: 7, event_type: "card_action", event_data: { action_id: "go" } }] }));
    const events = await client.pollOwned({ afterEventId: 6, limit: 10, waitSeconds: 5 });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ event_id: 6, limit: 10, wait: 5 });
    expect(events).toEqual([{ eventId: 7, eventType: "card_action", eventData: { action_id: "go" } }]);
    const { calls: shortCalls, client: short } = api(() => json(200, {}));
    expect(await short.pollOwned()).toEqual([]);
    expect(JSON.parse(String(shortCalls[0].init.body))).toEqual({ event_id: 0, limit: 20 });
    for (const body of ['{"results":{}}', '{"results":[{"event_id":"7"}]}', '{"results":[{"event_id":9007199254740993}]}', '{"results":[{"event_id":1,"event_data":[]}]}']) {
      expect(await failure(api(() => json(200, body)).client.pollOwned())).toMatchObject({ code: "malformed_response" });
    }
    expect(await failure(client.pollOwned({ waitSeconds: 30 }))).toBeInstanceOf(CardRequestError);
    expect(await failure(client.pollOwned({ limit: 101 }))).toBeInstanceOf(CardRequestError);
  });

  it("acks by numeric event id and fetches fresh members strictly", async () => {
    const { client, calls } = api((url) => url.endsWith("/ack") ? json(200, {}) : json(200, { members: [{ uid: "u1", name: "A" }, { uid: "u2" }] }));
    await client.ack(42);
    expect(calls[0].url).toBe("https://api.example.com/base/v1/bot/events/42/ack");
    expect(calls[0].init.method).toBe("POST");
    expect(await client.getFreshMembers("grp/1")).toEqual([{ uid: "u1" }, { uid: "u2" }]);
    expect(calls[1].url).toBe("https://api.example.com/base/v1/bot/groups/grp%2F1/members");
    expect(await failure(client.ack(-1))).toBeInstanceOf(CardRequestError);
    expect(await failure(api(() => json(200, { members: [{ name: "no uid" }] })).client.getFreshMembers("g"))).toMatchObject({ code: "malformed_response" });
    expect(await failure(api(() => json(200, { data: [] })).client.getFreshMembers("g"))).toMatchObject({ code: "malformed_response" });
  });

  it("refuses unsafe configuration at construction", () => {
    expect(() => createCardApi({ apiUrl: "https://u:p@api.example.com", credential: TOKEN })).toThrow();
    expect(() => createCardApi({ apiUrl: "http://api.example.com", credential: TOKEN })).toThrow();
    expect(() => createCardApi({ apiUrl: "https://api.example.com", credential: "a\r\nX-Injected: 1" })).toThrow(CardRequestError);
  });
});

describe("typed profile boundary", () => {
  const CONFIG = {
    card_enabled: true, reasoning_enabled: true, reasoning_template_ref: { id: "ai.reasoning-process", version: "0.4.0" },
    display_enabled: true, interaction_enabled: false,
  };
  const FULL = {
    available: true,
    enabled: 1,
    profiles: ["octo/v1", "octo/v2"],
    card_version: "1.5",
    elements: ["TextBlock", "Container"],
    inputs: ["Input.Text"],
    actions: ["Action.OpenUrl"],
    limits: { max_nodes: 200, max_depth: 12, max_payload_bytes: 16384, max_input_text_bytes: 4096, max_inputs_bytes: 16384, future_limit: 1 },
    templating: {
      supported: true, wire: "template-ref/v1", extension: { x: 1 },
      templates: [{ id: "ai.reasoning-process", version: "0.4.0", owner: "x",
        views: [{ name: "active", states: ["reasoning", "answering"], wire_profile: "octo/v2", submit_actions: [], hint: "y" }] }],
    },
    config: CONFIG,
    future_capability: { anything: true },
  };

  it("projects a good profile into closed typed fields and drops extensions", async () => {
    const profile = await api(() => json(200, FULL)).client.getProfile();
    expect(profile).toEqual({
      available: true,
      enabled: true,
      profiles: ["octo/v1", "octo/v2"],
      card_version: "1.5",
      elements: ["TextBlock", "Container"],
      inputs: ["Input.Text"],
      actions: ["Action.OpenUrl"],
      limits: { max_nodes: 200, max_depth: 12, max_payload_bytes: 16384, max_input_text_bytes: 4096, max_inputs_bytes: 16384 },
      templating: {
        supported: true, wire: "template-ref/v1",
        templates: [{ id: "ai.reasoning-process", version: "0.4.0",
          views: [{ name: "active", states: ["reasoning", "answering"], wire_profile: "octo/v2", submit_actions: [] }] }],
      },
      config: CONFIG,
    });
    expect(JSON.stringify(profile)).not.toMatch(/future_|extension|owner|hint/);
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it("passes missing fields through as absent for the policy parser", async () => {
    expect(await api(() => json(200, {})).client.getProfile()).toEqual({});
    expect(await api(() => json(200, { available: true })).client.getProfile()).toEqual({ available: true });
    const views = projectCardProfile({ templating: { templates: [{ id: "t", version: "1", views: [{ name: "result", wire_profile: "octo/v1" }] }] } });
    expect(views.templating?.templates?.[0].views[0]).toEqual({ name: "result", states: [], wire_profile: "octo/v1", submit_actions: [] });
    // Non-reasoning template refs are not restricted here; selection is a later package.
    expect(projectCardProfile({ config: { ...CONFIG, reasoning_template_ref: { id: "other.template", version: "9" } } }).config?.reasoning_template_ref)
      .toEqual({ id: "other.template", version: "9" });
  });

  it("classifies malformed config as resolved disabled(malformed) with a closed diagnostic", async () => {
    const secret = "zz_raw_secret_marker";
    const bad: [unknown, string][] = [
      [{ ...CONFIG, display_enabled: "true" }, "config_type"],
      [{ ...CONFIG, card_enabled: 1 }, "config_type"],
      [{ ...CONFIG, [secret]: true }, "config_unknown_key"],
      [{ card_enabled: true }, "config_shape"],
      [[CONFIG], "config_shape"],
      [{ ...CONFIG, reasoning_template_ref: { id: "ai.reasoning-process" } }, "template_ref_shape"],
      [{ ...CONFIG, reasoning_template_ref: { id: " ai.reasoning-process", version: "0.4.0" } }, "template_ref_shape"],
      [{ ...CONFIG, reasoning_template_ref: { id: "a", version: "1", [secret]: 1 } }, "template_ref_shape"],
      [{ ...CONFIG, reasoning_template_ref: "ai.reasoning-process@0.4.0" }, "template_ref_shape"],
    ];
    for (const [config, detail] of bad) {
      const err = await failure(api(() => json(200, { available: true, config })).client.getProfile());
      expect(err).toMatchObject({ transport: "response", status: 200, code: "malformed_config", detail });
      expect(classifyProfileFailure(err)).toEqual({ category: "disabled", reason: "malformed", cache: true });
      expect(err.message).not.toContain(secret);
      expect(JSON.stringify(err)).not.toContain(secret);
    }
  });

  it("keeps other malformed-success faults unavailable and uncached", async () => {
    const bad: [unknown, string][] = [
      [[], "profile_shape"],
      [{ available: "yes" }, "compat_type"],
      [{ profiles: "octo/v1" }, "capability_list"],
      [{ elements: [1] }, "capability_list"],
      [{ limits: { max_nodes: "200" } }, "limits_type"],
      [{ limits: [] }, "limits_type"],
      [{ templating: { supported: "true" } }, "templating_type"],
      [{ templating: { templates: [{ id: "t", version: "1", views: [{ name: 1, wire_profile: "octo/v1" }] }] } }, "templating_type"],
    ];
    for (const [body, detail] of bad) {
      const err = await failure(api(() => json(200, body)).client.getProfile());
      expect(err).toMatchObject({ code: "malformed_response", detail });
      expect(classifyProfileFailure(err)).toEqual({ category: "unavailable", cache: false });
    }
  });

  it("distinguishes transport failure from malformed content", async () => {
    const network = await failure(api(() => { throw new TypeError("down"); }).client.getProfile());
    expect(network).toMatchObject({ transport: "network" });
    expect((network as OctoApiError).detail).toBeUndefined();
    expect(classifyProfileFailure(network)).toEqual({ category: "unavailable", cache: false });
    const notFound = await failure(api(() => json(404, {})).client.getProfile());
    expect(classifyProfileFailure(notFound)).toEqual({ category: "disabled", reason: "profile_404", cache: true });
    const malformed = await failure(api(() => json(200, { config: { card_enabled: "x" } })).client.getProfile());
    expect(classifyProfileFailure(malformed)).toEqual({ category: "disabled", reason: "malformed", cache: true });
  });
});

describe("message identity is never zero", () => {
  it("rejects zero identities in requests and acknowledgements but keeps int64 max lossless", async () => {
    expect(() => serializeEditRegistry({ route: ROUTE, messageId: "0", ref: REF, state: "reasoning", data: DATA, seq: 1, transient: true }))
      .toThrow(/message_id/);
    for (const body of ['{"message_id":0}', '{"message_id":"0"}', '{"message_id":-1}', '{"message_id":1.5}', '{"message_id":9007199254740993.5}']) {
      const err = await failure(api(() => json(200, body)).client.sendRegistry({ route: ROUTE, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: DATA }));
      expect(err).toMatchObject({ code: "missing_identity" });
      expect(classifySendFailure(err)).toBe("ambiguous");
    }
    const editErr = await failure(api(() => json(200, '{"message_id":0}')).client.editRegistry({
      route: ROUTE, messageId: "5", ref: REF, state: "reasoning", data: DATA, seq: 1, transient: true,
    }));
    expect(editErr).toMatchObject({ code: "missing_identity" });
    const max = "9223372036854775807";
    const ack = await api(() => json(200, `{"message_id":${max}}`)).client.sendRegistry({ route: ROUTE, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: DATA });
    expect(ack.messageId).toBe(max);
  });
});

describe("Registry phase shapes", () => {
  const action = DATA.phases[0].actions[0];
  const send = (phases: unknown) => serializeSendRegistry({
    route: ROUTE, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: { ...DATA, phases } as RegistryData,
  });

  it("accepts a tool-only frame with a nonempty neutral thought label", () => {
    const phases = [
      { thought: "—", actions: [action] },
      { thought: "x", actions: [{ ...action }] },
    ];
    expect(JSON.parse(send(phases).body).payload.data.phases).toEqual(phases);
  });

  it("rejects an empty or blank action detail (server schema minLength 1)", () => {
    for (const detail of ["", " "]) {
      expect(() => send([{ thought: "x", actions: [{ ...action, detail }] }])).toThrow(CardRequestError);
    }
  });

  it("rejects blank wire thoughts and actionless phases with fixed safe fields", () => {
    for (const thought of ["", " ", "\n\t"]) {
      expect(() => send([{ thought, actions: [action] }])).toThrow(/phase\.thought/);
    }
    expect(() => send([{ thought: "Considering options", actions: [] }])).toThrow(/data\.phases\.actions/);
    expect(() => send([{ thought: "t", actions: [action] }, { thought: "u", actions: [] }])).toThrow(/data\.phases\.actions/);
    try { send([{ thought: "SECRET_THOUGHT", actions: [] }]); } catch (err) {
      expect(err).toBeInstanceOf(CardRequestError);
      expect(String((err as Error).message)).not.toContain("SECRET_THOUGHT");
    }
  });

  it("enforces the 280-scalar thought maximum exactly", () => {
    const astral = String.fromCodePoint(0x1f600);
    expect(() => send([{ thought: "t".repeat(280), actions: [action] }])).not.toThrow();
    expect(() => send([{ thought: astral.repeat(280), actions: [action] }])).not.toThrow();
    expect(() => send([{ thought: "t".repeat(281), actions: [action] }])).toThrow(/phase\.thought/);
    expect(() => send([{ thought: astral.repeat(281), actions: [action] }])).toThrow(/phase\.thought/);
  });

  it("preserves the 6-phase and 12-action caps with fixed safe errors", () => {
    expect(() => send(Array(6).fill({ thought: "t", actions: [action, action] }))).not.toThrow();
    expect(() => send(Array(7).fill({ thought: "t", actions: [action] }))).toThrow(/data\.phases/);
    expect(() => send(Array(5).fill({ thought: "t", actions: [action, action, action] }))).toThrow(/data\.phases\.actions/);
    expect(() => send([{ thought: "t", actions: [{ ...action, detail: "d".repeat(193) }] }])).toThrow(/action\.detail/);
    expect(() => send([{ thought: 5, actions: [action] }])).toThrow(/phase\.thought/);
  });
});

describe("Registry template ref", () => {
  const send = (ref: unknown) => serializeSendRegistry({
    route: ROUTE, clientMsgNo: CLIENT, ref: ref as typeof REF, state: "reasoning", data: DATA,
  });
  const fieldOf = (ref: unknown): string => {
    try { send(ref); } catch (err) {
      expect(err).toBeInstanceOf(CardRequestError);
      expect((err as CardRequestError).code).toBe("invalid_request");
      const message = String((err as Error).message);
      expect(message).not.toContain("SECRET");
      return (err as CardRequestError).field;
    }
    throw new Error("expected rejection");
  };

  it("preserves an exact server-selected non-semver version literally", () => {
    const version = "2026.10/预览-β+build";
    const body = JSON.parse(send({ id: "ai.reasoning-process", version }).body);
    expect(body.payload.template_ref).toEqual({ id: "ai.reasoning-process", version });
    expect(Object.keys(body.payload.template_ref)).toEqual(["id", "version"]);
    expect(send(Object.assign(Object.create(null), { id: "ai.reasoning-process", version: "0.4.0" })).body)
      .toBe(send(REF).body);
  });

  it("rejects malformed refs and versions with a constant safe field", () => {
    const secret = Symbol("SECRET_KEY");
    const nonEnumerable = { id: "ai.reasoning-process", version: "0.4.0" };
    Object.defineProperty(nonEnumerable, "SECRET_HIDDEN", { value: 1, enumerable: false });
    class Ref { id = "ai.reasoning-process"; version = "0.4.0"; }
    const bad: unknown[] = [
      null, undefined, "ai.reasoning-process@0.4.0", ["ai.reasoning-process", "0.4.0"], new Ref(),
      { id: "ai.reasoning-process" },
      { id: "ai.reasoning-process", version: "0.4.0", SECRET_EXTRA: "SECRET_VALUE" },
      { id: "ai.reasoning-process", version: "0.4.0", [secret]: 1 },
      nonEnumerable,
      { id: "other.SECRET", version: "0.4.0" },
      { id: " ai.reasoning-process", version: "0.4.0" },
      { id: "ai.reasoning-process", version: 4 },
      { id: "ai.reasoning-process", version: "" },
      { id: "ai.reasoning-process", version: "   " },
      { id: "ai.reasoning-process", version: " SECRET0.4.0" },
      { id: "ai.reasoning-process", version: "SECRET0.4.0\n" },
      { id: "ai.reasoning-process", version: "SECRET\u00000.4.0" },
      { id: "ai.reasoning-process", version: "SECRET\u007f" },
      { id: "ai.reasoning-process", version: "SECRET\u0085" },
      { id: "ai.reasoning-process", version: "SECRET\ud800" },
    ];
    for (const ref of bad) expect(fieldOf(ref)).toBe("template_ref");
  });
});

describe("bounded authored-card projection", () => {
  const header = { type: "AdaptiveCard" as const, version: "1.5" as const, $schema: "http://adaptivecards.io/schemas/adaptive-card.json" as const };
  const sendDisplay = (card: unknown) => serializeSendAuthored({
    route: ROUTE, clientMsgNo: CLIENT, profile: "octo/v1", card: card as DisplayAdaptiveCard, plain: "x",
  });
  const sendInteractive = (card: unknown) => serializeSendAuthored({
    route: ROUTE, clientMsgNo: CLIENT, profile: "octo/v2", card: card as InteractiveAdaptiveCard, plain: "x",
  });
  const nest = (levels: number): unknown => {
    let node: unknown = { type: "TextBlock", text: "leaf", wrap: true };
    for (let i = 1; i < levels; i++) node = { type: "Container", items: [node] };
    return node;
  };
  const errorField = (fn: () => unknown): string => {
    try { fn(); } catch (err) { expect(err).toBeInstanceOf(CardRequestError); return (err as CardRequestError).field; }
    throw new Error("expected rejection");
  };

  it("bounds depth at 12 before recursing, even for a corrupted deep runtime value", () => {
    expect(() => sendDisplay({ ...header, body: [nest(12)] })).not.toThrow();
    expect(errorField(() => sendDisplay({ ...header, body: [nest(13)] }))).toBe("card.depth");
    expect(errorField(() => sendDisplay({ ...header, body: [nest(100_000)] }))).toBe("card.depth");
    let cyclic: { type: string; items: unknown[] } = { type: "Container", items: [] };
    cyclic.items.push(cyclic);
    expect(errorField(() => sendDisplay({ ...header, body: [cyclic] }))).toBe("card.depth");
    cyclic = { type: "Container", items: [] };
  });

  it("bounds rendered nodes at 200 across the whole card", () => {
    const block = { type: "TextBlock", text: "x", wrap: true };
    expect(() => sendDisplay({ ...header, body: Array(200).fill(block) })).not.toThrow();
    expect(errorField(() => sendDisplay({ ...header, body: Array(201).fill(block) }))).toBe("card.nodes");
    expect(errorField(() => sendDisplay({ ...header, body: Array(1_000_000).fill(block) }))).toBe("card.nodes");
    const facts = { type: "FactSet", facts: Array(200).fill({ title: "a", value: "b" }) };
    expect(errorField(() => sendDisplay({ ...header, body: [facts] }))).toBe("card.nodes");
  });

  it("rejects reserved routing/credential keys in button data, nested or not", () => {
    for (const data of [{ channel_id: "g" }, { nested: { apiToken: "x" } }, { list: [{ on_behalf_of: "u" }] }, { Authorization: "x" }]) {
      const card = { ...INTERACTIVE_CARD, actions: [{ type: "Action.Submit", id: "go", title: "Go", data }] };
      const field = errorField(() => sendInteractive(card));
      expect(field).toBe("Action.Submit.data.reserved_key");
    }
  });

  it("bounds button data depth, entries and aggregate bytes like the protocol grammar", () => {
    const submit = (data: unknown, n = 1) => ({ ...INTERACTIVE_CARD,
      actions: Array.from({ length: n }, (_, i) => ({ type: "Action.Submit", id: `b${i}`, title: "B", data })) });
    expect(() => sendInteractive(submit({ a: { b: { c: 1 } } }))).not.toThrow();
    expect(errorField(() => sendInteractive(submit({ a: { b: { c: { d: 1 } } } })))).toBe("Action.Submit.data.depth");
    expect(errorField(() => sendInteractive(submit(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i]))))))
      .toBe("Action.Submit.data.entries");
    expect(errorField(() => sendInteractive(submit({ blob: "y".repeat(2100) })))).toBe("Action.Submit.data.bytes");
    expect(errorField(() => sendInteractive(submit({ blob: "z".repeat(1100) }, 2)))).toBe("Action.Submit.data.bytes");
    expect(errorField(() => sendInteractive(submit({ n: Number.NaN })))).toBe("Action.Submit.data");
  });

  it("reports only fixed field names, never caller content", () => {
    const marker = "zz_caller_content_marker";
    try {
      sendDisplay({ ...header, body: [{ type: marker }] });
    } catch (err) {
      expect((err as Error).message).not.toContain(marker);
      expect((err as CardRequestError).field).toBe("body.type");
    }
  });
});

describe("acknowledged identities are exact integer tokens", () => {
  // Each token is a non-integral (or inexact) JSON number that IEEE-754
  // rounds to `rounded`. The rounded value is supplied as the matching
  // identity, so only exact-token checking can refuse the acknowledgement.
  const ROUNDED_IDS = [
    { name: "fraction just above one", token: "1.0000000000000001", rounded: "1" },
    { name: "fraction above max safe integer", token: "9007199254740991.1", rounded: "9007199254740991" },
    { name: "exponent form of a fraction", token: "1.0000000000000001e0", rounded: "1" },
    { name: "uppercase signed exponent", token: "1.0000000000000001E+0", rounded: "1" },
    { name: "fraction just below one", token: "0.99999999999999999", rounded: "1" },
    { name: "fraction rounding up to max safe integer", token: "9007199254740990.9", rounded: "9007199254740991" },
    { name: "positive exponent rounding to ten", token: "1.00000000000000001e1", rounded: "10" },
    { name: "negative exponent rounding to one", token: "100000000000000001e-17", rounded: "1" },
    { name: "sub-one mantissa rounding up via exponent", token: "9.9999999999999999e-1", rounded: "1" },
  ] as const;

  const CANONICAL_IDS = [
    { name: "safe integer", token: "1", id: "1" },
    { name: "max safe integer", token: "9007199254740991", id: "9007199254740991" },
    { name: "raw int64", token: BIG_ID, id: BIG_ID },
    { name: "string int64", token: `"${BIG_ID}"`, id: BIG_ID },
  ] as const;

  const EXACT_INTEGRAL_IDS = [
    { name: "trailing zero fraction", token: "1.0", id: "1" },
    { name: "zero exponent", token: "1e0", id: "1" },
    { name: "negative exponent", token: "10e-1", id: "1" },
    { name: "fractional mantissa", token: "0.1e1", id: "1" },
    { name: "max safe integer with zero fraction", token: "9007199254740991.0", id: "9007199254740991" },
    { name: "max safe integer via negative exponent", token: "90071992547409910e-1", id: "9007199254740991" },
  ] as const;

  const ROUNDED_SEQS = [
    { name: "fraction above", token: "3.0000000000000001", rounded: 3 },
    { name: "fraction below", token: "2.9999999999999999", rounded: 3 },
    { name: "exponent form", token: "3.0000000000000001e0", rounded: 3 },
    { name: "negative exponent", token: "30000000000000001e-16", rounded: 3 },
  ] as const;

  const EXACT_SEQS = [
    { name: "integer", token: "3" },
    { name: "trailing zero fraction", token: "3.0" },
    { name: "zero exponent", token: "3e0" },
    { name: "fractional mantissa", token: "0.3e1" },
  ] as const;

  const IDENTITY_REJECTIONS = ["missing_identity", "malformed_response"];
  const SEQ_REJECTIONS = ["malformed_response", "identity_mismatch", "missing_identity"];

  const sendRegistry = (body: string) => api(() => json(200, body)).client.sendRegistry({
    route: ROUTE, clientMsgNo: CLIENT, ref: REF, state: "reasoning", data: DATA,
  });
  const sendAuthored = (body: string) => api(() => json(200, body)).client.sendAuthored({
    route: ROUTE, clientMsgNo: CLIENT, profile: "octo/v1", card: DISPLAY_CARD, plain: "Report",
  });
  const editRegistry = (body: string, messageId: string, seq = 4) => api(() => json(200, body)).client.editRegistry({
    route: ROUTE, messageId, ref: REF, state: "reasoning", data: DATA, seq, transient: true,
  });
  const editAuthored = (body: string, messageId: string, seq = 4) => api(() => json(200, body)).client.editAuthored({
    route: ROUTE, messageId, profile: "octo/v1", card: DISPLAY_CARD, plain: "Report", seq, transient: false,
  });
  const sendAck = (token: string) => `{"message_id":${token},"client_msg_no":"${CLIENT}"}`;

  async function settle<T>(p: Promise<T>): Promise<{ ack: T } | { err: unknown }> {
    return p.then((ack) => ({ ack }), (err: unknown) => ({ err }));
  }

  async function expectRefused(p: Promise<unknown>, codes: readonly string[]): Promise<void> {
    const outcome = await settle(p);
    expect(outcome).not.toHaveProperty("ack");
    const err = (outcome as { err: unknown }).err;
    expect(err).toBeInstanceOf(OctoApiError);
    expect(codes).toContain((err as OctoApiError).code);
  }

  it.each(ROUNDED_IDS)("rounded fixtures really round to the matching identity: $token", ({ token, rounded }) => {
    expect(Number(token)).toBe(Number(rounded));
    expect(Number.isSafeInteger(Number(token))).toBe(true);
  });

  it.each(ROUNDED_IDS)("sendRegistry refuses rounded message_id $token ($name)", async ({ token }) => {
    await expectRefused(sendRegistry(sendAck(token)), IDENTITY_REJECTIONS);
  });

  it.each(ROUNDED_IDS)("sendAuthored refuses rounded message_id $token ($name)", async ({ token }) => {
    await expectRefused(sendAuthored(sendAck(token)), IDENTITY_REJECTIONS);
  });

  it.each(ROUNDED_IDS)("editRegistry refuses rounded message_id $token echoed for $rounded ($name)", async ({ token, rounded }) => {
    await expectRefused(editRegistry(`{"message_id":${token}}`, rounded), IDENTITY_REJECTIONS);
  });

  it.each(ROUNDED_IDS)("editAuthored refuses rounded message_id $token echoed for $rounded ($name)", async ({ token, rounded }) => {
    await expectRefused(editAuthored(`{"message_id":${token}}`, rounded), IDENTITY_REJECTIONS);
  });

  it.each([...CANONICAL_IDS, ...EXACT_INTEGRAL_IDS])("send and edit acknowledge exact message_id $token ($name)", async ({ token, id }) => {
    expect((await sendRegistry(sendAck(token))).messageId).toBe(id);
    expect((await sendAuthored(sendAck(token))).messageId).toBe(id);
    expect(await editRegistry(`{"message_id":${token}}`, id)).toMatchObject({ messageId: id, seq: 4 });
    expect(await editAuthored(`{"message_id":${token}}`, id)).toMatchObject({ messageId: id, seq: 4 });
  });

  it.each(ROUNDED_SEQS)("sendRegistry and sendAuthored refuse rounded message_seq $token ($name)", async ({ token, rounded }) => {
    expect(Number(token)).toBe(rounded);
    const body = `{"message_id":"5","client_msg_no":"${CLIENT}","message_seq":${token}}`;
    await expectRefused(sendRegistry(body), IDENTITY_REJECTIONS);
    await expectRefused(sendAuthored(body), IDENTITY_REJECTIONS);
  });

  it.each(ROUNDED_SEQS)("editRegistry and editAuthored refuse rounded card_seq $token ($name)", async ({ token, rounded }) => {
    expect(Number(token)).toBe(rounded);
    const body = `{"message_id":"5","card_seq":${token}}`;
    await expectRefused(editRegistry(body, "5", rounded), SEQ_REJECTIONS);
    await expectRefused(editAuthored(body, "5", rounded), SEQ_REJECTIONS);
  });

  it.each(EXACT_SEQS)("exact message_seq and card_seq $token ($name) are acknowledged", async ({ token }) => {
    expect((await sendRegistry(`{"message_id":"5","client_msg_no":"${CLIENT}","message_seq":${token}}`)).messageSeq).toBe(3);
    expect((await sendAuthored(`{"message_id":"5","client_msg_no":"${CLIENT}","message_seq":${token}}`)).messageSeq).toBe(3);
    expect(await editRegistry(`{"message_id":"5","card_seq":${token}}`, "5", 3)).toMatchObject({ messageId: "5", seq: 3 });
    expect(await editAuthored(`{"message_id":"5","card_seq":${token}}`, "5", 3)).toMatchObject({ messageId: "5", seq: 3 });
  });
});
