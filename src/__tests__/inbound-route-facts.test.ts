/**
 * Inbound route facts (WP-09 RC-1, owner scope 2026-10-27 19:58).
 *
 * - the pure derivation of `obo` / `docTask` from the adapter-owned origin,
 *   the inbound payload's top-level keys and the Bot's own outbound identity
 *   (T1–T4, T7);
 * - the cycle-safe, depth-bounded merged-`Config` scan (T5);
 * - the non-test string tripwire (T6) and the closed outbound bodies of every
 *   ordinary and card send (T6b);
 * - structural checks on the single origin producer and turn entry (T8).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createCardApi } from "../cards/api.js";
import type { DisplayAdaptiveCard, RegistryData } from "../cards/contracts.js";
import { CRON_FIRE_NONCE, CRON_FIRE_NONCE_KEY, isAuthenticCronFire } from "../cron-fire-marker.js";
import { WS_IM_ORIGIN, deriveOutboundIdentity, deriveRouteFacts, type InboundOrigin } from "../inbound-route-facts.js";
import * as octoApi from "../octo/api.js";
import { ChannelType, MessageType, type BotMessage } from "../octo/types.js";
import { SessionRouter } from "../session-router.js";
import { loadConfig, resolveBotConfigs, type Config } from "../config.js";
import { serverSendAck, SERVER_EDIT_ACK } from "./fixtures/octo-server-acks.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** octo-server `pkg/obopayload/payload.go:111-124` (`ExplicitReservedKeys`) at `adb7c385`. */
const EXPLICIT_RESERVED_KEYS = [
  "obo_respond_as", "obo_grantor_uid", "obo_fanout", "obo_origin_channel_id", "obo_origin_channel_type", "obo_origin_from_uid",
  "obo_origin_message_id", "obo_origin_message_idstr", "obo_grantor_name", "obo_system_hint", "actual_sender_uid",
] as const;

/** Shape of `buildFanoutCopyReq` (`modules/bot_api/obo_fanout.go:778-800`) over an ordinary text payload. */
const FANOUT_COPY = {
  type: MessageType.Text, content: "hello",
  obo_fanout: true, obo_origin_channel_id: "g1", obo_origin_channel_type: 2, obo_origin_from_uid: "u_bob",
  obo_origin_message_id: "123", obo_origin_message_idstr: "123", obo_respond_as: "u_admin", obo_grantor_uid: "u_admin",
  obo_grantor_name: "Admin", obo_system_hint: "hint",
};

const clean = () => ({ type: MessageType.Text, content: "hello" });
/** WS IM origin unless an origin argument is given explicitly (including `undefined`). */
const facts = (payload: unknown, ...rest: [origin?: unknown, outboundIdentity?: "self" | "unknown"]) =>
  deriveRouteFacts({ origin: (rest.length === 0 ? WS_IM_ORIGIN : rest[0]) as InboundOrigin | undefined, payload, outboundIdentity: rest[1] ?? "self" });

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "__fixtures__" || name === "data") continue;
      out.push(...sourceFiles(p));
    } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(SRC, p).split("\\").join("/");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

// ─── T1: ordinary WS IM route ───────────────────────────────────────────────

describe("T1: the adapter-owned WS IM origin with a clean payload and the Bot's own identity", () => {
  it("derives both route facts proven false", () => {
    expect(facts(clean())).toEqual({ obo: false, docTask: false });
  });

  it("is frozen and carries no other key", () => {
    const f = facts(clean());
    expect(Object.isFrozen(f)).toBe(true);
    expect(Object.keys(f).sort()).toEqual(["docTask", "obo"]);
  });

  it("an unknown outbound identity keeps obo unknown; docTask stays a transport fact", () => {
    expect(facts(clean(), WS_IM_ORIGIN, "unknown")).toEqual({ obo: undefined, docTask: false });
  });

  it("an outbound identity other than the exact 'self' is unknown", () => {
    for (const id of ["SELF", "", undefined, null, true, { self: true }]) {
      expect(deriveRouteFacts({ origin: WS_IM_ORIGIN, payload: clean(), outboundIdentity: id as never }).obo).toBeUndefined();
    }
  });

  it("a payload that cannot be inspected keeps obo unknown", () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error("no"); } });
    for (const p of [undefined, null, "text", 7, hostile]) expect(facts(p)).toEqual({ obo: undefined, docTask: false });
  });
});

// ─── T2: known OBO markers suppress ─────────────────────────────────────────

describe("T2: every top-level reserved OBO key derives obo true", () => {
  const keys = ["__obo_processed__", "__obo_x", ...EXPLICIT_RESERVED_KEYS, "obo_future", "obo_processed"];
  it.each(keys)("%s", (key) => {
    for (const value of [true, "x", 0, null, {}]) {
      expect(facts({ ...clean(), [key]: value })).toEqual({ obo: true, docTask: false });
      // Known OBO wins over every other input, so a forged key can only suppress.
      expect(facts({ ...clean(), [key]: value }, undefined, "unknown").obo).toBe(true);
    }
  });

  it("the full fan-out copy and the send.go OBO marker block", () => {
    expect(facts(FANOUT_COPY)).toEqual({ obo: true, docTask: false });
    expect(facts({ ...clean(), __obo_processed__: true, actual_sender_uid: "bot" })).toEqual({ obo: true, docTask: false });
  });

  it("all 11 ExplicitReservedKeys are covered", () => {
    expect(EXPLICIT_RESERVED_KEYS).toHaveLength(11);
    for (const key of EXPLICIT_RESERVED_KEYS) expect(facts({ [key]: 1 }).obo).toBe(true);
  });

  it("look-alike keys that are not reserved do not suppress", () => {
    for (const key of ["obo", "_obo_x", "xobo_y", "OBO_FANOUT", "actual_sender", "actual_sender_uid_x", "sender_uid"]) {
      expect(facts({ ...clean(), [key]: true })).toEqual({ obo: false, docTask: false });
    }
  });
});

// ─── T3: nested markers ─────────────────────────────────────────────────────

describe("T3: a reserved key below the top level has no effect", () => {
  it("under extra, reply or an array", () => {
    for (const p of [{ ...clean(), extra: { obo_fanout: true, __obo_processed__: true, actual_sender_uid: "b" } },
      { ...clean(), reply: { payload: FANOUT_COPY } }, { ...clean(), entities: [{ obo_grantor_uid: "u" }] }]) {
      expect(facts(p)).toEqual({ obo: false, docTask: false });
    }
  });
});

// ─── T4: forged or missing origin ───────────────────────────────────────────

describe("T4: only the frozen module token is the WS IM origin", () => {
  it("no origin, the string 'ws_im' or a look-alike object derives both facts unknown", () => {
    const lookalikes: unknown[] = [undefined, null, "ws_im", "WS_IM_ORIGIN", { kind: "ws_im" }, { ...WS_IM_ORIGIN },
      Object.freeze({ ...WS_IM_ORIGIN }), Object.create(WS_IM_ORIGIN as object), structuredClone({ kind: "ws_im" }), [WS_IM_ORIGIN]];
    for (const origin of lookalikes) expect(facts(clean(), origin)).toEqual({ obo: undefined, docTask: undefined });
  });

  it("payload-claimed origin fields are ignored", () => {
    for (const p of [{ ...clean(), origin: "ws_im" }, { ...clean(), origin: WS_IM_ORIGIN }, { ...clean(), route_origin: "ws_im", ws_im: true }]) {
      expect(facts(p, undefined)).toEqual({ obo: undefined, docTask: undefined });
    }
  });

  it("the token is frozen and cannot be re-pointed", () => {
    expect(Object.isFrozen(WS_IM_ORIGIN)).toBe(true);
    expect(() => { (WS_IM_ORIGIN as { kind: string }).kind = "x"; }).toThrow();
  });
});

// ─── T5: merged Config scan ─────────────────────────────────────────────────

describe("T5: deriveOutboundIdentity over the merged per-Bot Config", () => {
  const base = (): Record<string, unknown> => ({ botToken: "t", apiUrl: "https://a.invalid", cwd: "/w", dataDir: "/d",
    sdk: { model: "m", env: { A: "1" }, additionalDirectories: ["/x"] }, rateLimit: { maxPerMinute: 10 },
    cards: Object.freeze({ disable: false, eventTransport: "off", reasoningSummary: "off" }), bots: [{ id: "a" }] });

  it("a clean config is 'self'", () => {
    expect(deriveOutboundIdentity(base())).toBe("self");
    expect(deriveOutboundIdentity(Object.assign(Object.create(null), { a: 1 }))).toBe("self");
  });

  it("an OBO key at the top level, nested, or inside an array is 'unknown'", () => {
    for (const key of ["onBehalfOf", "on_behalf_of"]) {
      for (const value of ["u_admin", "", null, false, {}]) {
        expect(deriveOutboundIdentity({ ...base(), [key]: value })).toBe("unknown");
        expect(deriveOutboundIdentity({ ...base(), sdk: { env: { [key]: value } } })).toBe("unknown");
        expect(deriveOutboundIdentity({ ...base(), bots: [{ id: "a" }, { id: "b", persona: [{ [key]: value }] }] })).toBe("unknown");
      }
    }
  });

  it("spelling variants of the OBO key fail closed too", () => {
    for (const key of ["OnBehalfOf", "ON_BEHALF_OF", "on-behalf-of", "onbehalfof"]) {
      expect(deriveOutboundIdentity({ ...base(), x: { [key]: "u" } })).toBe("unknown");
    }
  });

  it("a cyclic config does not throw and still finds a hit", () => {
    const a: Record<string, unknown> = base();
    a.self = a;
    (a.sdk as Record<string, unknown>).parent = a;
    expect(deriveOutboundIdentity(a)).toBe("self");
    (a.sdk as Record<string, unknown>).deep = { onBehalfOf: "u" };
    expect(deriveOutboundIdentity(a)).toBe("unknown");
  });

  it("a config deeper than the bound is 'unknown', without a stack overflow", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 100_000; i++) { const next = {}; deep.n = next; deep = next; }
    expect(deriveOutboundIdentity(root)).toBe("unknown");
    let arr: unknown[] = [];
    const top = arr;
    for (let i = 0; i < 100_000; i++) { const next: unknown[] = []; arr.push(next); arr = next; }
    expect(deriveOutboundIdentity(top)).toBe("unknown");
  });

  it("a config with too many nodes is 'unknown'", () => {
    expect(deriveOutboundIdentity({ list: Array.from({ length: 200_000 }, () => ({})) })).toBe("unknown");
  });

  it("uninspectable values are 'unknown' and never invoked", () => {
    const getter = vi.fn(() => "u");
    const accessor = Object.defineProperty({}, "x", { get: getter, enumerable: true });
    const hostile = new Proxy({}, { ownKeys() { throw new Error("no"); } });
    for (const v of [accessor, hostile, () => 1, new Map([["onBehalfOf", "u"]]), new (class Persona { onBehalfOf = "u"; })()]) {
      expect(deriveOutboundIdentity({ ...base(), v })).toBe("unknown");
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("a non-object config is 'unknown'", () => {
    for (const v of [undefined, null, "x", 1, [], [{}]]) expect(deriveOutboundIdentity(v)).toBe("unknown");
  });

  it("the repository's example configs are 'self'", () => {
    for (const name of ["config.example.json", "config.bot.example.json", "config.bot.docker.example.json"]) {
      const parsed = JSON.parse(readFileSync(join(SRC, "..", name), "utf8")) as Partial<Config>;
      expect(deriveOutboundIdentity(parsed)).toBe("self");
    }
  });
});

// ─── T6: string tripwire ────────────────────────────────────────────────────

describe("K2: configuration projection retains suppression without retaining raw values", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function fixture(layer: string, marker: Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), "route-config-"));
    roots.push(root);
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "config.json"), JSON.stringify({ apiUrl: "https://a.invalid",
      bots: [{ id: "test", ...(layer === "inline" ? marker : {}) }], ...(layer === "global" ? marker : {}) }), { mode: 0o600 });
    writeFileSync(join(root, "test", "config.json"), JSON.stringify({ botToken: "fixture-token", ...(layer === "per-file" ? marker : {}) }), { mode: 0o600 });
    const loaded = loadConfig(join(root, "config.json"));
    return { loaded, resolved: resolveBotConfigs(loaded)[0] };
  }

  it.each(["global", "inline", "per-file"])("%s raw keys suppress through all projections and clean later layers", (layer) => {
    for (const key of ["onBehalfOf", "on_behalf_of"]) {
      for (const marker of [{ [key]: "fixture-sensitive-value" }, { discarded: [{ [key]: "fixture-sensitive-value" }] }]) {
        const { loaded, resolved } = fixture(layer, marker);
        expect(deriveOutboundIdentity(resolved)).toBe("unknown");
        expect(deriveOutboundIdentity(resolveBotConfigs(loaded)[0])).toBe("unknown");
        expect(JSON.stringify(resolved)).not.toContain("fixture-sensitive-value");
        expect(Object.keys(resolved)).not.toContain(key);
        const symbols = Object.getOwnPropertySymbols(resolved);
        expect(symbols).toHaveLength(1);
        expect(Object.getOwnPropertyDescriptor(resolved, symbols[0])).toEqual({
          value: true, enumerable: false, writable: false, configurable: false,
        });
      }
    }
  });

  it("a clean resolved config remains self", () => {
    const { resolved } = fixture("per-file", {});
    expect(deriveOutboundIdentity(resolved)).toBe("self");
  });
});

describe("T6: OBO strings appear in non-test source only inside inbound-route-facts.ts", () => {
  it("on_behalf_of / onBehalfOf", () => {
    const hits = sourceFiles(SRC).filter((f) => /on_behalf_of|onBehalfOf/i.test(readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual(["inbound-route-facts.ts"]);
  });

  it("the reserved inbound key names", () => {
    const hits = sourceFiles(SRC).filter((f) => /__obo_|actual_sender_uid|["'`]obo_/.test(readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual(["inbound-route-facts.ts"]);
  });
});

// ─── T6b: closed outbound bodies ────────────────────────────────────────────

describe("T6b: every outbound send body is closed and carries no OBO field", () => {
  const bodies: { path: string; body: Record<string, unknown> }[] = [];
  const OBO = /on_?behalf_?of|^obo_|^__obo_|actual_sender_uid/i;
  afterEach(() => { vi.unstubAllGlobals(); bodies.length = 0; });

  function capture(path: string, init?: RequestInit): void {
    if (typeof init?.body === "string" && init.body.length > 0) bodies.push({ path, body: JSON.parse(init.body) as Record<string, unknown> });
  }
  function assertClosed(allow: Record<string, readonly string[]>): void {
    expect(bodies.length).toBeGreaterThan(0);
    for (const { path, body } of bodies) {
      const key = Object.keys(allow).find((p) => path.endsWith(p));
      expect(key, path).toBeDefined();
      for (const k of Object.keys(body)) expect(allow[key!], `${path}: ${k}`).toContain(k);
      const nested = (v: unknown): void => {
        if (typeof v === "string" && v.startsWith("{")) { try { nested(JSON.parse(v)); } catch { /* plain text */ } return; }
        if (v === null || typeof v !== "object") return;
        for (const [k, x] of Object.entries(v)) { expect(k, `${path}: ${k}`).not.toMatch(OBO); nested(x); }
      };
      nested(body);
    }
  }

  it("src/octo/api.ts: every exported POST through the generic poster", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capture(new URL(String(url)).pathname, init);
      return new Response(JSON.stringify({ message_id: "1", robot_id: "b", im_token: "t", ws_url: "ws://x", api_url: "https://a.invalid",
        owner_uid: "o", owner_channel_id: "c", messages: [] }));
    }));
    const common = { apiUrl: "https://a.invalid", botToken: "t" };
    await octoApi.sendMessage({ ...common, channelId: "c", channelType: ChannelType.Group, content: "x", mentionUids: ["u"],
      mentionEntities: [{ uid: "u", offset: 0, length: 1 }], mentionAll: true, replyMsgId: "9", clientMsgNo: "n" });
    await octoApi.sendTyping({ ...common, channelId: "c", channelType: ChannelType.DM });
    await octoApi.sendHeartbeat(common);
    await octoApi.registerBot({ ...common, agentPlatform: "p", agentVersion: "v" });
    await octoApi.sendReadReceipt({ ...common, channelId: "c", channelType: ChannelType.DM, messageIds: ["1"] });
    await octoApi.getChannelMessages({ ...common, channelId: "c", channelType: ChannelType.DM });
    await octoApi.postJson(common.apiUrl, common.botToken, "/v1/bot/heartbeat", {});
    assertClosed({
      "/v1/bot/sendMessage": ["channel_id", "channel_type", "payload", "client_msg_no"],
      "/v1/bot/typing": ["channel_id", "channel_type"],
      "/v1/bot/heartbeat": [],
      "/v1/bot/register": ["agent_platform", "agent_version"],
      "/v1/bot/readReceipt": ["channel_id", "channel_type", "message_ids"],
      "/v1/bot/messages/sync": ["channel_id", "channel_type", "limit", "start_message_seq", "end_message_seq", "pull_mode"],
    });
    expect(Object.keys(bodies.find((b) => b.path.endsWith("/sendMessage"))!.body.payload as object).sort())
      .toEqual(["content", "mention", "reply", "type"]);
  });

  it("src/cards/api.ts: the card transport's send and edit envelopes", async () => {
    const data: RegistryData = { reasoningId: "octo-progress", state: "reasoning", title: "Reasoning", statusLabel: "Working",
      statusTone: "Accent", timerText: "…", traceExpanded: true, traceCollapsed: false, collapsedSummary: "s", progressText: "p",
      phases: [{ thought: "—", actions: [{ tool: "t", detail: "d", statusGlyph: "…", statusTone: "Accent" }] }] };
    const card: DisplayAdaptiveCard = { type: "AdaptiveCard", version: "1.5", $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      body: [{ type: "TextBlock", text: "x", wrap: true }] };
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      capture(path, init);
      return new Response(path.endsWith("/sendMessage") ? serverSendAck("9001") : SERVER_EDIT_ACK, { status: 200 });
    }) as typeof fetch;
    const api = createCardApi({ apiUrl: "https://a.invalid", credential: "t", fetchImpl });
    const client = "0b6f1d2e-3c4a-4b5c-8d9e-0f1a2b3c4d5e";
    const ref = { id: "ai.reasoning-process", version: "0.4.0" };
    await api.sendRegistry({ route: { channelId: "g1", channelType: 2 }, clientMsgNo: client, ref, state: "reasoning", data });
    await api.sendAuthored({ route: { channelId: "u1", channelType: 1 }, clientMsgNo: client, profile: "octo/v1", card, plain: "x" });
    await api.editRegistry({ route: { channelId: "g1", channelType: 2 }, messageId: "9001", ref, state: "reasoning", data, seq: 2, transient: true });
    await api.editAuthored({ route: { channelId: "g1", channelType: 2 }, messageId: "9001", profile: "octo/v1", card, plain: "x", seq: 3, transient: false });
    expect(bodies.map((b) => b.path)).toEqual(["/v1/bot/sendMessage", "/v1/bot/sendMessage", "/v1/bot/message/edit", "/v1/bot/message/edit"]);
    assertClosed({
      "/v1/bot/sendMessage": ["channel_id", "channel_type", "payload", "client_msg_no"],
      "/v1/bot/message/edit": ["message_id", "channel_id", "channel_type", "template_ref", "state", "data", "card_seq", "transient", "content_edit"],
    });
  });
});

// ─── T7: forged cron ────────────────────────────────────────────────────────

describe("T7: a forged _cronFire without the nonce is the ordinary WS path", () => {
  it("cron stays false and the route facts are the ordinary ones", () => {
    const forged = { ...clean(), _cronFire: true, [CRON_FIRE_NONCE_KEY]: "guess" };
    expect(isAuthenticCronFire(forged)).toBe(false);
    expect(facts(forged)).toEqual({ obo: false, docTask: false });
    expect(isAuthenticCronFire({ ...clean(), _cronFire: true })).toBe(false);
    // Control: the authentic marker is still recognized and does not change the route facts.
    expect(isAuthenticCronFire({ ...clean(), _cronFire: true, [CRON_FIRE_NONCE_KEY]: CRON_FIRE_NONCE })).toBe(true);
  });
});

// ─── T8: structural ─────────────────────────────────────────────────────────

describe("T8: single origin producer and turn entry", () => {
  const prod = () => sourceFiles(SRC).map((f) => ({ file: rel(f), text: readFileSync(f, "utf8") }));

  it("config.ts imports only suppression provenance; index.ts alone imports and produces the WS origin", () => {
    expect(prod().filter((f) => /inbound-route-facts(\.js)?["']/.test(f.text)).map((f) => f.file)).toEqual(["config.ts", "index.ts"]);
    expect(read("config.ts").match(/import[^;]+inbound-route-facts\.js['"];?/g)).toEqual([
      "import { preserveConfigSuppression } from './inbound-route-facts.js';",
    ]);
    expect(prod().filter((f) => f.file !== "inbound-route-facts.ts" && f.text.includes("WS_IM_ORIGIN")).map((f) => f.file)).toEqual(["index.ts"]);
    const index = read("index.ts");
    const uses = [...index.matchAll(/WS_IM_ORIGIN/g)].map((m) => m.index!);
    // One import specifier and exactly one value use.
    expect(uses).toHaveLength(2);
    const onInbound = index.slice(index.indexOf("const onInbound = (msg: BotMessage): void => {"), index.indexOf("gateway.setMessageHandler(onInbound);"));
    expect(onInbound.length).toBeGreaterThan(0);
    expect(onInbound).toMatch(/handleMessage\(msg, config, [^\n]*, cardRuntime, WS_IM_ORIGIN, outboundIdentity\)/);
    expect(index.match(/deriveOutboundIdentity\(/g)).toHaveLength(1);
    expect(index.match(/deriveRouteFacts\(/g)).toHaveLength(1);
  });

  it("handleMessage and beginTurn each have exactly one production call site", () => {
    const calls = (re: RegExp) => prod().flatMap((f) => [...f.text.matchAll(re)].map(() => f.file));
    expect(calls(/(?<![\w.])handleMessage\(msg,/g)).toEqual(["index.ts"]);
    expect(calls(/cardRuntime\.beginTurn\(|runtime\.beginTurn\(/g)).toEqual(["index.ts"]);
  });

  it("pollOwned has no production caller, so no polled event reaches handleMessage", () => {
    const callers = prod().filter((f) => /\.pollOwned\(/.test(f.text)).map((f) => f.file);
    expect(callers).toEqual([]);
  });

  it("a WS message carrying payload.event never becomes a turn", async () => {
    const config = { botToken: "t", apiUrl: "https://a.invalid", cwd: "/w", dataDir: "/d", sdk: {}, rateLimit: { maxPerMinute: 100 },
      context: { maxContextChars: 6000, historyLimit: 40 } } as unknown as Config;
    const router = new SessionRouter(config, "bot", () => "human");
    const handler = vi.fn(async () => {});
    for (const type of ["doc_comment_mention", "bot_task", "group_md_updated", "anything"]) {
      for (const channelType of [ChannelType.DM, ChannelType.Group]) {
        const msg = { message_id: "1", message_seq: 1, from_uid: "human", channel_id: "human", channel_type: channelType, timestamp: 0,
          payload: { type: MessageType.Text, content: "hi", event: { type } } } as unknown as BotMessage;
        expect(await router.routeAndHandle(msg, handler)).toBeNull();
      }
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
