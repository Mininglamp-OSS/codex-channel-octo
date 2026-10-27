/**
 * Local synthetic transport evidence: the real card API client and the
 * platform fetch against loopback `node:http` servers. This proves client
 * envelopes, credential scoping and fail-closed transport handling only; it is
 * never live P01–P10 acceptance of the Octo server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CardRequestError, classifySendFailure, createCardApi, OctoApiError, type CardApi } from "../cards/api.js";
import type { DisplayAdaptiveCard, RegistryData } from "../cards/contracts.js";
import { SERVER_EDIT_ACK, SERVER_GENERATED_CLIENT_MSG_NO, serverSendAck } from "./fixtures/octo-server-acks.js";

const TOKEN = "loopback_fixture_token_7f3a";
const CLIENT = "0b6f1d2e-3c4a-4b5c-8d9e-0f1a2b3c4d5e";
const BIG_ID = "9223372036854775001";

interface Seen {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

function startServer(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body });
      handler(req, body, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, seen }));
  });
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
}

const DATA: RegistryData = {
  reasoningId: "octo-progress",
  state: "reasoning",
  title: "Reasoning",
  statusLabel: "Working",
  statusTone: "Accent",
  timerText: "Reasoning…",
  traceExpanded: true,
  traceCollapsed: false,
  collapsedSummary: "Reasoning in progress",
  progressText: "1 step so far",
  phases: [{ thought: "—", actions: [{ tool: "Running command", detail: "git", statusGlyph: "…", statusTone: "Accent" }] }],
};

const CARD: DisplayAdaptiveCard = {
  type: "AdaptiveCard",
  version: "1.5",
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  body: [{ type: "TextBlock", text: "Loopback", wrap: true }],
};

let octo: Awaited<ReturnType<typeof startServer>>;
let foreign: Awaited<ReturnType<typeof startServer>>;
let client: CardApi;
let hanging: ServerResponse[] = [];

beforeAll(async () => {
  foreign = await startServer((_req, _body, res) => send(res, 200, `{"message_id":"1"}`));
  octo = await startServer((req, _body, res) => {
    const path = req.url ?? "";
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, "{}");
    switch (path) {
      case "/base/v1/bot/card/profile":
        return send(res, 200, JSON.stringify({ available: true, enabled: true, profiles: ["octo/v1", "octo/v2"], card_version: "1.5" }));
      // Real Bot API success bodies: server-assigned client_msg_no, bare edit status.
      case "/base/v1/bot/sendMessage":
        return send(res, 200, serverSendAck(BIG_ID, SERVER_GENERATED_CLIENT_MSG_NO, 3));
      case "/base/v1/bot/message/edit":
        return send(res, 200, SERVER_EDIT_ACK);
      case "/base/v1/bot/events":
        return send(res, 200, JSON.stringify({ results: [{ event_id: 11, event_type: "card_action", event_data: { action_id: "go" } }] }));
      case "/base/v1/bot/events/11/ack":
        return send(res, 200, "{}");
      case "/base/v1/bot/groups/g1/members":
        return send(res, 200, JSON.stringify({ members: [{ uid: "u1", name: "A", role: 1 }] }));
      case "/base/v1/bot/groups/huge/members": {
        res.writeHead(200, { "content-type": "application/json" });
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        let sent = 0;
        const pump = (): void => {
          while (sent < 64 && !res.destroyed) {
            sent++;
            if (!res.write(chunk)) { res.once("drain", pump); return; }
          }
          res.end();
        };
        res.on("error", () => undefined);
        return pump();
      }
      case "/base/v1/bot/groups/slow/members":
        hanging.push(res);
        return;
      case "/redir/v1/bot/card/profile":
        return send(res, 307, "{}", { location: `http://127.0.0.1:${foreign.port}/v1/bot/card/profile` });
      case "/redir/v1/bot/sendMessage":
        return send(res, 308, "{}", { location: `http://127.0.0.1:${foreign.port}/v1/bot/sendMessage` });
      default:
        return send(res, 404, "{}");
    }
  });
  client = createCardApi({ apiUrl: `http://127.0.0.1:${octo.port}/base/`, credential: TOKEN });
});

afterAll(async () => {
  for (const res of hanging) res.destroy();
  hanging = [];
  await Promise.all([octo, foreign].map(({ server }) => new Promise<void>((r) => server.close(() => r()))));
});

describe("card API over loopback HTTP", () => {
  it("fetches the profile with the configured bearer on the retained base path", async () => {
    const profile = await client.getProfile();
    expect(profile).toMatchObject({ available: true, profiles: ["octo/v1", "octo/v2"] });
    const req = octo.seen.find((s) => s.url === "/base/v1/bot/card/profile");
    expect(req).toMatchObject({ method: "GET", authorization: `Bearer ${TOKEN}`, body: "" });
  });

  it("sends Registry and authored envelopes byte-for-byte and parses a lossless int64 identity", async () => {
    const registry = await client.sendRegistry({
      route: { channelId: "g1", channelType: 2 }, clientMsgNo: CLIENT,
      ref: { id: "ai.reasoning-process", version: "0.4.0" }, state: "reasoning", data: DATA,
    });
    expect(registry.messageId).toBe(BIG_ID);
    expect(registry.clientMsgNo).toBe(CLIENT);
    expect(registry.serverClientMsgNo).toBe(SERVER_GENERATED_CLIENT_MSG_NO);
    expect(registry.messageSeq).toBe(3);
    const received = octo.seen.filter((s) => s.url === "/base/v1/bot/sendMessage");
    expect(received.at(-1)?.body).toBe(registry.request.body);
    expect(JSON.parse(received.at(-1)!.body).payload).toMatchObject({ type: 17, template_ref: { id: "ai.reasoning-process", version: "0.4.0" }, state: "reasoning" });

    const authored = await client.sendAuthored({
      route: { channelId: "u1", channelType: 1 }, clientMsgNo: CLIENT, profile: "octo/v1", card: CARD, plain: "Loopback",
    });
    expect(authored.messageId).toBe(BIG_ID);
    expect(JSON.parse(octo.seen.at(-1)!.body).payload).toEqual({ type: 17, card: CARD, profile: "octo/v1", card_version: "1.5", plain: "Loopback" });
  });

  it("edits with a Registry envelope and an exact serialized content_edit", async () => {
    const reg = await client.editRegistry({
      route: { channelId: "g1", channelType: 2 }, messageId: BIG_ID,
      ref: { id: "ai.reasoning-process", version: "0.4.0" }, state: "reasoning", data: DATA, seq: 2, transient: true,
    });
    expect(reg).toMatchObject({ messageId: BIG_ID, seq: 2 });
    const authored = await client.editAuthored({
      route: { channelId: "g1", channelType: 2 }, messageId: BIG_ID, profile: "octo/v1", card: CARD, plain: "Loopback", seq: 3, transient: false,
    });
    const wire = JSON.parse(octo.seen.at(-1)!.body);
    expect(octo.seen.at(-1)!.body).toBe(authored.request.body);
    expect(JSON.parse(wire.content_edit)).toEqual({ type: 17, card: CARD, profile: "octo/v1", card_version: "1.5", plain: "Loopback", card_seq: 3 });
  });

  it("polls, acks and reads fresh membership", async () => {
    expect(await client.pollOwned({ afterEventId: 10, limit: 5 })).toEqual([{ eventId: 11, eventType: "card_action", eventData: { action_id: "go" } }]);
    expect(JSON.parse(octo.seen.at(-1)!.body)).toEqual({ event_id: 10, limit: 5 });
    await client.ack(11);
    expect(octo.seen.at(-1)).toMatchObject({ method: "POST", url: "/base/v1/bot/events/11/ack", body: "{}" });
    expect(await client.getFreshMembers("g1")).toEqual([{ uid: "u1" }]);
  });

  it("never follows a redirect, so the credential cannot reach another origin", async () => {
    const redirecting = createCardApi({ apiUrl: `http://127.0.0.1:${octo.port}/redir`, credential: TOKEN });
    const before = foreign.seen.length;
    const profileErr = await redirecting.getProfile().catch((e: unknown) => e);
    expect(profileErr).toBeInstanceOf(OctoApiError);
    expect(profileErr).toMatchObject({ status: 307, code: "redirect_refused" });
    const sendErr = await redirecting.sendAuthored({
      route: { channelId: "g1", channelType: 2 }, clientMsgNo: CLIENT, profile: "octo/v1", card: CARD, plain: "x",
    }).catch((e: unknown) => e as OctoApiError);
    expect(sendErr).toMatchObject({ status: 308, code: "redirect_refused" });
    expect(classifySendFailure(sendErr as OctoApiError)).toBe("ambiguous");
    expect(foreign.seen.length).toBe(before);
    expect(foreign.seen.some((s) => s.authorization !== undefined)).toBe(false);
  });

  it("stops reading an oversized streamed body", async () => {
    const err = await client.getFreshMembers("huge").catch((e: unknown) => e);
    expect(err).toMatchObject({ transport: "response", code: "response_too_large" });
  });

  it("aborts a stalled response at the deadline and maps a closed port to network", async () => {
    const started = Date.now();
    const err = await client.getFreshMembers("slow", { deadlineMs: 150 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ transport: "timeout", code: "timeout", status: 0 });
    expect(Date.now() - started).toBeLessThan(5_000);

    const closed = await startServer(() => undefined);
    const closedPort = closed.port;
    await new Promise<void>((r) => closed.server.close(() => r()));
    const offline = createCardApi({ apiUrl: `http://127.0.0.1:${closedPort}`, credential: TOKEN });
    const netErr = await offline.getProfile().catch((e: unknown) => e as Error);
    expect(netErr).toMatchObject({ transport: "network", code: "network" });
    expect((netErr as Error).message).not.toContain(TOKEN);
  });

  it("maps an unauthorized response to a typed status without exposing the body", async () => {
    const wrong = createCardApi({ apiUrl: `http://127.0.0.1:${octo.port}/base`, credential: "other_token" });
    const err = await wrong.getProfile().catch((e: unknown) => e as OctoApiError);
    expect(err).toMatchObject({ transport: "response", status: 401, code: "http_status" });
  });
});

describe("membership path segments over a dedicated loopback server", () => {
  async function closeServer(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }

  async function withMembersServer(run: (api: CardApi, seen: Seen[]) => Promise<void>): Promise<void> {
    // Answers every captured path with members, so a normalized request
    // would be wrongly acknowledged instead of failing on a missing route.
    const members = await startServer((_req, _body, res) => send(res, 200, JSON.stringify({ members: [{ uid: "captured" }] })));
    try {
      await run(createCardApi({ apiUrl: `http://127.0.0.1:${members.port}/base`, credential: TOKEN }), members.seen);
    } finally {
      await closeServer(members.server);
    }
  }

  it("rejects '.' and '..' group identifiers before any normalized request reaches the server", async () => {
    await withMembersServer(async (api, seen) => {
      for (const groupNo of [".", ".."]) {
        const err = await api.getFreshMembers(groupNo).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CardRequestError);
        expect(err).toMatchObject({ code: "invalid_request", field: "group_no" });
      }
      expect(seen).toEqual([]);
    });
  });

  it("delivers slash, space, Unicode and literal %2e identifiers as one encoded segment", async () => {
    await withMembersServer(async (api, seen) => {
      const cases: [string, string][] = [
        ["grp/1", "grp%2F1"],
        ["team alpha", "team%20alpha"],
        ["研发 组", "%E7%A0%94%E5%8F%91%20%E7%BB%84"],
        ["%2e", "%252e"],
        ["%2e%2e", "%252e%252e"],
      ];
      for (const [groupNo, segment] of cases) {
        expect(await api.getFreshMembers(groupNo)).toEqual([{ uid: "captured" }]);
        expect(seen.at(-1)).toMatchObject({
          method: "GET", url: `/base/v1/bot/groups/${segment}/members`, authorization: `Bearer ${TOKEN}`,
        });
      }
      expect(seen).toHaveLength(cases.length);
    });
  });
});
