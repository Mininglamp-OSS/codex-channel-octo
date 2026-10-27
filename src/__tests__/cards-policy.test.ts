import { describe, expect, it, vi } from "vitest";
import { createPolicy } from "../cards/policy.js";
import { createCardApi, OctoApiError } from "../cards/api.js";
import { normalizeOrigin } from "../cards/origin.js";
import type { BotRef, CardProfileWire, PolicySnapshot } from "../cards/contracts.js";
import { profile } from "./fixtures/card-profile.js";

const ORIGIN = normalizeOrigin("https://api.example.com");
const A: BotRef = { originKey: ORIGIN.key, credentialRef: "opaque-a" };
const B: BotRef = { originKey: ORIGIN.key, credentialRef: "opaque-b" };
const deny = () => profile({ config: { card_enabled: false, reasoning_enabled: false,
  reasoning_template_ref: null, display_enabled: false, interaction_enabled: false } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function setup(getProfile: () => Promise<CardProfileWire> = async () => profile(), botRef = A, ttlMs = 60000) {
  let time = 1000;
  const fetch = vi.fn(getProfile);
  const policy = createPolicy({ botRef, api: { origin: ORIGIN, getProfile: fetch },
    clock: { nowMono: () => time }, ttlMs });
  return { policy, fetch, at: (t: number) => { time = t; } };
}
function states(p: PolicySnapshot) { return [p.automatic.state, p.display.state, p.interaction.state]; }

describe("per-Bot monotonic cache", () => {
  it.each([59999, 60000, 60001])("expires at exactly the TTL boundary +%i ms", async offset => {
    const s = setup(); const first = await s.policy.snapshot();
    expect(first.fetchedAtMono).toBe(1000); expect(first.expiresAtMono).toBe(61000);
    s.at(1000 + offset); const second = await s.policy.snapshot();
    expect(s.fetch).toHaveBeenCalledTimes(offset < 60000 ? 1 : 2);
    expect(second === first).toBe(offset < 60000);
  });
  it("starts TTL before fetching so a slow fetch cannot extend authority", async () => {
    const pending = deferred<CardProfileWire>(); const s = setup(() => pending.promise);
    const request = s.policy.snapshot(); s.at(61000); pending.resolve(profile());
    const result = await request;
    expect(states(result)).toEqual(["unavailable", "unavailable", "unavailable"]);
    await s.policy.snapshot(); expect(s.fetch).toHaveBeenCalledTimes(2);
  });
  it("single-flights concurrent misses for the same Bot and generation", async () => {
    const pending = deferred<CardProfileWire>(); const s = setup(() => pending.promise);
    const requests = Array.from({ length: 20 }, () => s.policy.snapshot());
    expect(s.fetch).toHaveBeenCalledTimes(1); pending.resolve(profile());
    const results = await Promise.all(requests);
    expect(results.every(p => p === results[0])).toBe(true);
  });
  it("isolates Bots sharing one normalized origin, including invalidation and failures", async () => {
    const pending = deferred<CardProfileWire>();
    const a = setup(() => pending.promise, A); const b = setup(async () => deny(), B);
    const ar = a.policy.snapshot(); const br = await b.policy.snapshot();
    expect(states(br)).toEqual(["disabled", "disabled", "disabled"]);
    pending.resolve(profile()); const as = await ar;
    expect(states(as)).toEqual(["enabled", "enabled", "enabled"]);
    expect(a.policy.authorize("display", { botRef: A }, as).allowed).toBe(true);
    expect(a.policy.authorize("display", { botRef: B }, as).allowed).toBe(false);
    a.policy.invalidate("bot_setting");
    expect(await b.policy.snapshot()).toBe(br);
    expect(states(await b.policy.snapshot())).toEqual(["disabled", "disabled", "disabled"]);
    expect((await b.policy.snapshot()).botRef).toEqual(B);
    expect((await b.policy.snapshot()).generation).toBe(0);
    expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(a.policy.authorize("display", { botRef: B }, as).allowed).toBe(false);
    expect(b.policy.authorize("display", { botRef: A }, as).allowed).toBe(false);
  });
  it("binds trusted identity at construction and retains no caller-controlled identity", async () => {
    const bot = { ...A }; const s = setup(async () => profile(), bot);
    bot.credentialRef = "changed"; const p = await s.policy.snapshot();
    expect(p.botRef).toEqual(A); expect(Object.isFrozen(p.botRef)).toBe(true);
    expect(() => setup(async () => profile(), { ...A, originKey: "https://foreign.example:443" })).toThrow();
    expect(() => setup(async () => profile(), { ...A, credentialRef: "" })).toThrow();
    for (const ttl of [0, -1, 1.1, NaN, Infinity, 60001]) expect(() => setup(undefined, A, ttl)).toThrow();
  });
  it("cache results retain no raw profile or credential or thrown payload", async () => {
    const source = profile(); const s = setup(async () => source);
    const p = await s.policy.snapshot();
    expect(p.profileHash).toMatch(/^[a-f0-9]{64}$/);
    (source.elements as string[]).push("secret-content");
    expect(JSON.stringify(p)).not.toContain("secret-content");
    expect("add" in p.display.elements).toBe(false);
    const bad = setup(async () => { throw new Error("credential_SECRET_RAW_RESPONSE"); });
    expect(JSON.stringify(await bad.policy.snapshot())).not.toContain("SECRET_RAW");
  });
  it("the snapshot carries the advertised display actions and they are part of the profile hash", async () => {
    const full = await setup().policy.snapshot();
    const openOnly = await setup(async () => profile({ actions: ["Action.OpenUrl"] })).policy.snapshot();
    expect([...openOnly.display.actions]).toEqual(["Action.OpenUrl"]);
    expect("add" in openOnly.display.actions).toBe(false);
    expect(openOnly.display.state).toBe("enabled");
    // Only the display action subset differs: interaction (with Action.Submit) and elements stay identical.
    const openSubmit = await setup(async () => profile({ actions: ["Action.OpenUrl", "Action.Submit"] })).policy.snapshot();
    expect(states(openSubmit)).toEqual(states(full));
    expect(openSubmit.profileHash).not.toBe(full.profileHash);
    const reordered = await setup(async () => profile({ actions: [...profile().actions!].reverse() })).policy.snapshot();
    expect(reordered.profileHash).toBe(full.profileHash);
  });

  it("honors shorter configured TTLs and removes disabled entries at their exact deadline", async () => {
    const s = setup(async () => deny(), A, 100);
    await s.policy.snapshot(); s.at(1099); await s.policy.snapshot();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    s.at(1100); await s.policy.snapshot(); expect(s.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("resolved denials and unavailable fetches", () => {
  it.each([400, 422, 404, 401, 403])("caches definitive profile HTTP %i denial", async status => {
    const s = setup(async () => { throw new OctoApiError("get_profile", "response", status, "http_status"); });
    const p = await s.policy.snapshot(); await s.policy.snapshot();
    expect(states(p)).toEqual(["disabled", "disabled", "disabled"]);
    expect(p.reasons).toContain(status === 404 ? "profile_404" : status === 400 || status === 422 ? "profile_malformed" : "auth_rejected");
    expect(s.fetch).toHaveBeenCalledTimes(1);
    s.at(61000); await s.policy.snapshot(); expect(s.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    new Error("sensitive"), { status: 404, code: "http_status" },
    new OctoApiError("get_profile", "network", 0, "network"),
    new OctoApiError("get_profile", "timeout", 0, "timeout"),
    new OctoApiError("get_profile", "abort", 0, "aborted"),
    new OctoApiError("get_profile", "response", 200, "malformed_response"),
    new OctoApiError("get_profile", "response", 500, "http_status"),
    new OctoApiError("get_profile", "response", 429, "http_status"),
    new OctoApiError("send_authored", "response", 404, "http_status"),
  ])("does not cache thrown/network/timeout/unknown failure %#", async error => {
    const s = setup(async () => { throw error; });
    const p = await s.policy.snapshot(); await s.policy.snapshot();
    expect(states(p)).toEqual(["unavailable", "unavailable", "unavailable"]);
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.policy.authorize("display", { botRef: A }, p).allowed).toBe(false);
  });
  it("caches strict malformed config and resolved disabled profile", async () => {
    for (const getter of [async () => ({}), async () => deny(), async () => {
      throw new OctoApiError("get_profile", "response", 200, "malformed_config");
    }]) {
      const s = setup(getter); const p = await s.policy.snapshot(); await s.policy.snapshot();
      expect(states(p)).toEqual(["disabled", "disabled", "disabled"]);
      expect(s.fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("uses only the approved typed API profile boundary", async () => {
    const calls: string[] = [];
    const api = createCardApi({ apiUrl: "https://api.example.com", credential: "synthetic-token",
      fetchImpl: (async (url: string | URL | Request) => {
        calls.push(String(url)); return new Response(JSON.stringify(profile()));
      }) as typeof fetch });
    const policy = createPolicy({ botRef: A, api, clock: { nowMono: () => 0 } });
    expect(states(await policy.snapshot())).toEqual(["enabled", "enabled", "enabled"]);
    expect(calls).toEqual(["https://api.example.com/v1/bot/card/profile"]);
  });
});

describe("invalidation, revocation, restart and narrow closure distinction", () => {
  it("fences old in-flight positives and never clears newer in-flight work", async () => {
    const old = deferred<CardProfileWire>(); const fresh = deferred<CardProfileWire>();
    let calls = 0; const s = setup(() => ++calls === 1 ? old.promise : fresh.promise);
    const stale = s.policy.snapshot(); expect(s.policy.invalidate("bot_setting")).toBe(1);
    const current = s.policy.snapshot(); old.resolve(profile());
    const oldResult = await stale;
    expect(states(oldResult)).toEqual(["unavailable", "unavailable", "unavailable"]);
    const joined = s.policy.snapshot(); expect(s.fetch).toHaveBeenCalledTimes(2);
    fresh.resolve(deny()); expect(await current).toBe(await joined);
    expect(states(await s.policy.snapshot())).toEqual(["disabled", "disabled", "disabled"]);
  });
  it("fences old failures after the new generation succeeds", async () => {
    const old = deferred<CardProfileWire>(); let calls = 0;
    const s = setup(() => ++calls === 1 ? old.promise : Promise.resolve(profile()));
    const stale = s.policy.snapshot(); s.policy.invalidate("bot_setting");
    const current = await s.policy.snapshot(); old.reject(new Error("secret")); await stale;
    expect(await s.policy.snapshot()).toBe(current); expect(s.fetch).toHaveBeenCalledTimes(2);
  });
  it("increments only for trusted setting scope and immediately removes old authority", async () => {
    const s = setup(); const p = await s.policy.snapshot();
    expect(s.policy.authorize("automatic", { botRef: A }, p).allowed).toBe(true);
    expect(s.policy.invalidate("other")).toBe(0);
    expect(s.policy.invalidate("bot_setting")).toBe(1);
    expect(s.policy.authorize("automatic", { botRef: A }, p).allowed).toBe(false);
    expect(s.policy.invalidate("bot_setting")).toBe(2);
    expect((await s.policy.snapshot()).generation).toBe(2);
  });
  it("fresh deny narrows subsequent consumers, and stale-positive snapshots cannot grant", async () => {
    let value = profile(); const s = setup(async () => value); const p = await s.policy.snapshot();
    s.at(61000); value = deny(); const revoked = await s.policy.snapshot();
    expect(s.policy.authorize("display", { botRef: A }, p).allowed).toBe(false);
    expect(s.policy.closureDisposition("display", p, revoked)).toBe("denied");
    value = profile(); s.at(121000); await s.policy.snapshot();
    expect(s.policy.authorize("display", { botRef: A }, p).allowed).toBe(false);
  });
  it("distinguishes expired-fetch failure from revocation without granting write authority", async () => {
    let fail = false; const s = setup(async () => { if (fail) throw new Error("timeout"); return profile(); });
    const pinned = await s.policy.snapshot(); s.at(61000); fail = true;
    const unavailable = await s.policy.snapshot();
    expect(s.policy.authorize("automatic", { botRef: A }, pinned).allowed).toBe(false);
    expect(s.policy.closureDisposition("automatic", pinned, unavailable)).toBe("expired_closure_only");
    s.policy.invalidate("bot_setting");
    const invalidated = await s.policy.snapshot();
    expect(s.policy.closureDisposition("automatic", pinned, invalidated)).toBe("denied");
  });
  it("restart and fabricated/cross-instance snapshots carry no authority", async () => {
    const first = setup(); const p = await first.policy.snapshot(); const restart = setup();
    expect(restart.policy.authorize("display", { botRef: A }, p).allowed).toBe(false);
    expect(first.policy.authorize("display", { botRef: A }, { ...p }).allowed).toBe(false);
    expect(states(await restart.policy.snapshot())).toEqual(["enabled", "enabled", "enabled"]);
    expect(restart.fetch).toHaveBeenCalledTimes(1);
  });
  it("template changes cannot silently switch a pinned automatic card", async () => {
    let value = profile(); const s = setup(async () => value); const pinned = await s.policy.snapshot();
    const next = structuredClone(profile()); const version = "0.5.0";
    value = { ...next, config: { ...next.config!, reasoning_template_ref: { id: "ai.reasoning-process", version } },
      templating: { ...next.templating, templates: next.templating!.templates!.map(t => ({ ...t, version })) } };
    s.at(61000); const fresh = await s.policy.snapshot();
    expect(fresh.automatic.state).toBe("enabled");
    expect(s.policy.authorize("automatic", { botRef: A }, pinned).allowed).toBe(false);
  });
  it("suspends authority on a clock rollback or invalid clock", async () => {
    const s = setup(); const p = await s.policy.snapshot();
    for (const time of [999, NaN, Infinity]) {
      s.at(time); expect(s.policy.authorize("display", { botRef: A }, p).allowed).toBe(false);
      expect(states(await s.policy.snapshot())).toEqual(["unavailable", "unavailable", "unavailable"]);
    }
  });

  it("narrows live limits immediately but never enlarges pinned limits", async () => {
    let value = profile({ limits: { max_payload_bytes: 1000 } });
    const s = setup(async () => value); const pinned = await s.policy.snapshot();
    value = profile({ limits: { max_payload_bytes: 500 } }); s.at(61000); await s.policy.snapshot();
    const narrow = s.policy.authorize("display", { botRef: A }, pinned);
    expect(narrow.allowed && narrow.limits.maxPayloadBytes).toBe(500);
    value = profile(); s.at(121000); await s.policy.snapshot();
    const loose = s.policy.authorize("display", { botRef: A }, pinned);
    expect(loose.allowed && loose.limits.maxPayloadBytes).toBe(1000);
  });

  it("a prior explicit denial never becomes an expired-positive closure after fetch failure", async () => {
    let value = profile(); let fail = false;
    const s = setup(async () => { if (fail) throw new Error("unavailable"); return value; });
    const old = await s.policy.snapshot(); value = deny(); s.at(61000); await s.policy.snapshot();
    fail = true; s.at(121000); const unavailable = await s.policy.snapshot();
    expect(s.policy.closureDisposition("automatic", old, unavailable)).toBe("denied");
  });
});
