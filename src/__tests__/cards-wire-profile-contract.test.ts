/**
 * Canonical template view `wire_profile` contract (XIN-2418).
 *
 * The server advertises each `ai.reasoning-process` view with the canonical
 * card profile name (`octo/v2` for active/error, `octo/v1` for result), the
 * same enum as `pkg/cardmsg` `ProfileV1`/`ProfileV2`. These cases run the
 * sanitized live profile body through the real projection and parser.
 */
import { describe, expect, it } from "vitest";
import { projectCardProfile } from "../cards/api.js";
import { negotiate } from "../cards/caps.js";
import type { CardProfileWire, CardRoute, RegistryView } from "../cards/contracts.js";
import { parseProfile } from "../cards/profile-parse.js";
import { AUTOMATIC_REASONS, buildClosureFrame, isTerminalReason, lifecycleView, type BuildOptions } from "../cards/registry-builder.js";
import { selectTemplate } from "../cards/template.js";
import { liveProfileJson } from "./fixtures/card-profile-live.js";

const ROUTE: CardRoute = { channelId: "s1_u1@s1_bot", channelType: 1 };
const OPTS: BuildOptions = { reasoningId: "card-0000", elapsedMs: 1_000, route: ROUTE,
  clientMsgNo: "00000000-0000-4000-8000-000000000000", maxEnvelopeBytes: 16_384 };

function parsedLive(mutate?: (body: ReturnType<typeof liveProfileJson>) => void) {
  const body = liveProfileJson();
  mutate?.(body);
  return parseProfile(projectCardProfile(body as never));
}

function withViews(mutate: (views: { name: string; wire_profile: unknown; states: string[]; submit_actions: string[] }[]) => void) {
  return parsedLive(body => mutate(body.templating.templates[0].views as never));
}

describe("live card profile wire_profile contract", () => {
  it("enables automatic progress for the sanitized live profile and pins the server template", () => {
    const p = parsedLive();
    expect(p.automatic.state).toBe("enabled");
    expect(p.automatic.template).toEqual({ id: "ai.reasoning-process", version: "0.4.1", controlFree: true,
      views: { active: { view: "active", version: "octo/v2", controlFree: true },
        error: { view: "error", version: "octo/v2", controlFree: true },
        result: { view: "result", version: "octo/v1", controlFree: true } } });
    expect(p.reasons).not.toContain("template_incompatible");
    expect(negotiate(p).automatic.state).toBe("enabled");
  });

  it("intersects display elements on the live profile while interaction stays fail-closed", () => {
    const p = parsedLive();
    // Image/ImageSet are outside the client display element allowlist: display uses the known intersection only;
    // interaction keeps the strict list (and has no Action.Submit).
    expect([p.display.state, p.interaction.state]).toEqual(["enabled", "disabled"]);
    expect(p.reasons).toEqual(["profile_incompatible"]);
    expect([...p.display.elements].sort()).toEqual(["ActionSet", "ColumnSet", "Container", "FactSet", "RichTextBlock", "Table", "TextBlock"]);
    expect(parsedLive(b => { (b as { elements: string[] }).elements = b.elements.filter(e => e !== "TextBlock"); }).display.state).toBe("disabled");
    expect(parsedLive(b => { (b.actions as string[]).push("Action.Submit"); }).interaction.state).toBe("disabled");
    expect(parsedLive(b => { (b.actions as string[]).push("Action.Execute"); }).display.state).toBe("disabled");
  });

  it.each([
    ["bare legacy v2/v2/v1", ["v2", "v2", "v1"]],
    ["active as octo/v1", ["octo/v1", "octo/v2", "octo/v1"]],
    ["error as octo/v1", ["octo/v2", "octo/v1", "octo/v1"]],
    ["result as octo/v2", ["octo/v2", "octo/v2", "octo/v2"]],
    ["unknown version octo/v3", ["octo/v3", "octo/v2", "octo/v1"]],
    ["unknown namespace", ["acme/v2", "acme/v2", "acme/v1"]],
    ["case variant", ["OCTO/v2", "octo/v2", "octo/v1"]],
    ["padded", [" octo/v2", "octo/v2", "octo/v1"]],
    ["suffixed", ["octo/v2/x", "octo/v2", "octo/v1"]],
    ["mixed canonical and bare", ["octo/v2", "v2", "octo/v1"]],
    ["empty", ["", "octo/v2", "octo/v1"]],
  ])("rejects %s view profiles", (_label, profiles) => {
    const p = withViews(views => views.forEach((v, i) => { v.wire_profile = profiles[i]; }));
    expect(p.automatic.state).toBe("disabled");
    expect(p.automatic.template).toBeUndefined();
    expect(p.reasons).toContain("template_incompatible");
  });

  it.each(["active", "error", "result"])("rejects a missing %s view", name => {
    const p = withViews(views => views.splice(views.findIndex(v => v.name === name), 1));
    expect(p.automatic.state).toBe("disabled");
  });

  it.each([2, null, ["octo/v2"], { profile: "octo/v2" }])("fails closed on malformed wire_profile %j", bad => {
    expect(() => parsedLive(body => { (body.templating.templates[0].views[0] as { wire_profile: unknown }).wire_profile = bad; }))
      .toThrow();
    const raw = liveProfileJson() as unknown as CardProfileWire;
    (raw.templating!.templates![0].views[0] as { wire_profile: unknown }).wire_profile = bad;
    expect(selectTemplate(raw)).toBe("template_incompatible");
  });

  it("keeps the existing control and state checks on the canonical live profile", () => {
    expect(withViews(views => { views[0].submit_actions = ["reasoning_stop"]; }).automatic.state).toBe("disabled");
    expect(withViews(views => { views[1].submit_actions = ["reasoning_retry"]; }).automatic.state).toBe("disabled");
    expect(withViews(views => { views[0].states.push("paused"); }).automatic.state).toBe("disabled");
    expect(withViews(views => { views[2].states.pop(); }).automatic.state).toBe("disabled");
    expect(parsedLive(b => { b.config.reasoning_template_ref.version = "0.4.0"; }).automatic.state).toBe("disabled");
    expect(parsedLive(b => { b.templating.wire = "template-ref/v2"; }).automatic.state).toBe("disabled");
    expect(parsedLive(b => { b.config.reasoning_enabled = false; b.config.reasoning_template_ref = null as never; })
      .automatic.state).toBe("disabled");
  });

  it("builds registry frames whose state belongs to the live view selected for every reachable reason", () => {
    const live = liveProfileJson().templating.templates[0].views;
    const statesOf = (view: RegistryView) => live.find(v => v.name === view)!.states as readonly string[];
    const template = parsedLive().automatic.template!;
    for (const reason of AUTOMATIC_REASONS) {
      const v = lifecycleView(reason);
      expect(statesOf(v.view)).toContain(v.state);
      expect(template.views[v.view].version).toBe(live.find(x => x.name === v.view)!.wire_profile);
      if (!isTerminalReason(reason)) continue;
      const frame = buildClosureFrame(reason, template, OPTS)!;
      expect(frame.ref).toEqual({ id: "ai.reasoning-process", version: "0.4.1" });
      expect(statesOf(v.view)).toContain(frame.state);
    }
  });
});
