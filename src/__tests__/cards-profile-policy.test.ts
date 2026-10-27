import { describe, expect, it } from "vitest";
import { parseProfile } from "../cards/profile-parse.js";
import { negotiate } from "../cards/caps.js";
import { selectTemplate } from "../cards/template.js";
import { CARD_BOUNDS, effectiveLimits, measureEnvelope, measureStructure, normalizeLimits,
  withinCount, withinUtf8, withinScalars } from "../cards/limits.js";
import { profile } from "./fixtures/card-profile.js";
import { liveProfileJson } from "./fixtures/card-profile-live.js";
import { projectCardProfile } from "../cards/api.js";
import type { JsonValue } from "../cards/contracts.js";

function states(value: unknown) {
  const p = negotiate(parseProfile(value));
  return [p.automatic.state, p.display.state, p.interaction.state];
}
const ON = ["enabled", "enabled", "enabled"];
const OFF = ["disabled", "disabled", "disabled"];

describe("strict server profile policy", () => {
  it("enables independent compatible capabilities with conservative defaults", () => {
    expect(states(profile())).toEqual(ON);
    const p = parseProfile(profile());
    expect(p.display.limits).toEqual({ maxNodes: 200, maxDepth: 12, maxPayloadBytes: 16384,
      maxInputTextBytes: 4096, maxInputsBytes: 16384 });
    expect([...p.interaction.inputs]).toEqual(["text", "number", "date", "time", "toggle", "choice"]);
  });

  it.each([undefined, null, true, [], "profile", {}, { enabled: true, available: true },
    { card_enabled: true }, { cardDisplay: true, cardInteraction: true },
    { config: {} }, { config: { ...profile().config, card_enabled: 1 } },
    { config: { ...profile().config, unknown: true } },
    { config: { ...profile().config, card_enabled: false } },
    { config: { ...profile().config, reasoning_enabled: false } },
    { config: { ...profile().config, reasoning_template_ref: null } },
    { config: { ...profile().config, reasoning_template_ref: { id: "x", version: "1", extra: true } } },
  ])("fails closed on absent, malformed or contradictory configuration %#", (value) => {
    expect(states(value)).toEqual(OFF);
  });

  it("rejects prototypes/accessors/symbols without invoking untrusted code", () => {
    let touched = false;
    const getter = Object.defineProperty({}, "config", { enumerable: true, get() { touched = true; throw new Error("secret"); } });
    for (const p of [Object.create(profile()), getter, { ...profile(), [Symbol("x")]: true },
      { ...profile(), config: Object.create(profile().config!) },
      { ...profile(), limits: Object.create({ max_nodes: 1 }) },
      { ...profile(), elements: Object.assign(["TextBlock"], { extra: true }) }]) {
      expect(states(p)).toEqual(OFF);
    }
    expect(touched).toBe(false);
    expect(states(Object.assign(Object.create(null) as object, profile()))).toEqual(ON);
  });

  it("never derives permission from compatibility, legacy or local flags", () => {
    expect(states(profile({ enabled: false, available: false }))).toEqual(ON);
    const deny = profile({ config: { card_enabled: false, reasoning_enabled: false,
      reasoning_template_ref: null, display_enabled: false, interaction_enabled: false } });
    expect(states({ ...deny, enabled: true, available: true })).toEqual(OFF);
    expect(states({ ...deny, cardDisplay: true, cardInteraction: true, OCTO_CARD_MESSAGE_ENABLED: true })).toEqual(OFF);
    expect(negotiate(parseProfile(deny), { automatic: true, display: true, interaction: true }).display.state).toBe("disabled");
    const narrowed = negotiate(parseProfile(profile()), { automatic: false });
    expect([narrowed.automatic.state, narrowed.display.state, narrowed.interaction.state]).toEqual(["disabled", "enabled", "enabled"]);
  });
  it("rejects malformed boolean policy on an otherwise fully compatible profile", () => {
    for (const key of ["card_enabled", "reasoning_enabled", "display_enabled", "interaction_enabled"]) {
      for (const value of [1, "true", null]) {
        expect(states({ ...profile(), config: { ...profile().config, [key]: value } })).toEqual(OFF);
      }
    }
  });

  it.each(["reasoning_enabled", "display_enabled", "interaction_enabled"] as const)("disables only %s", (flag) => {
    const config = { ...profile().config!, [flag]: false,
      ...(flag === "reasoning_enabled" ? { reasoning_template_ref: null } : {}) };
    const expected = [...ON]; expected[["reasoning_enabled", "display_enabled", "interaction_enabled"].indexOf(flag)] = "disabled";
    expect(states(profile({ config }))).toEqual(expected);
  });

  it.each([
    [{ profiles: ["octo/v1"] }, ["enabled", "enabled", "disabled"]],
    [{ profiles: ["octo/v2"] }, ["enabled", "disabled", "enabled"]],
    [{ profiles: ["unknown"] }, ["enabled", "disabled", "disabled"]],
    [{ profiles: ["octo/v1", "octo/v1", "octo/v2"] }, ["enabled", "disabled", "disabled"]],
    [{ card_version: "1.6" }, ["enabled", "disabled", "disabled"]],
    [{ card_version: undefined }, ["enabled", "disabled", "disabled"]],
    [{ elements: [] }, ["enabled", "disabled", "disabled"]],
    [{ elements: ["TextBlock"] }, ON],
    // D-W2 Option A: an unknown element narrows interaction only; display intersects.
    [{ elements: ["TextBlock", "Image"] }, ["enabled", "enabled", "disabled"]],
    [{ elements: ["Image", "RichTextBlock"] }, ["enabled", "disabled", "disabled"]],
    [{ actions: ["Action.OpenUrl", "Action.Unknown"] }, ["enabled", "disabled", "disabled"]],
    [{ inputs: ["Input.Image"] }, ["enabled", "enabled", "disabled"]],
    [{ inputs: undefined }, ["enabled", "enabled", "disabled"]],
    [{ actions: ["Action.OpenUrl"] }, ["enabled", "enabled", "disabled"]],
    [{ actions: undefined }, ["enabled", "disabled", "disabled"]],
    [{ templating: undefined }, ["disabled", "enabled", "enabled"]],
    [{ templating: { supported: false } }, ["disabled", "enabled", "enabled"]],
    [{ limits: { max_nodes: 0 } }, ["enabled", "disabled", "disabled"]],
    [{ limits: { max_depth: -1 } }, ["enabled", "disabled", "disabled"]],
    [{ limits: { max_payload_bytes: 0 } }, OFF],
    [{ limits: { max_input_text_bytes: 0 } }, ["enabled", "enabled", "disabled"]],
    [{ limits: { max_inputs_bytes: 0 } }, ["enabled", "enabled", "disabled"]],
  ])("narrows exactly affected capability %#", (delta, expected) => {
    expect(states(profile(delta))).toEqual(expected);
  });

  it("rejects unknown keys at every projected contract boundary", () => {
    for (const p of [{ ...profile(), secret: "payload" },
      profile({ limits: { max_nodes: 10, extra: 1 } as unknown as NonNullable<ReturnType<typeof profile>["limits"]> }),
      { ...profile(), templating: { ...profile().templating, extra: true } },
    ]) expect(states(p)).toEqual(OFF);
  });

  it("rejects malformed compatibility flags without treating them as permission", () => {
    for (const key of ["enabled", "available"]) {
      for (const bad of ["true", 1, null, {}, []]) expect(states({ ...profile(), [key]: bad })).toEqual(OFF);
    }
  });

  it.each(["profiles", "elements", "inputs", "actions"] as const)("strictly validates %s lists", key => {
    for (const bad of [null, "TextBlock", [1], [""], [" TextBlock"], ["TextBlock\u0000"], ["x".repeat(129)],
      ["TextBlock", "TextBlock"], Array(257).fill("TextBlock")]) {
      expect(states({ ...profile(), [key]: bad })).not.toEqual(ON);
    }
  });

  it("rejects malformed direct template data without throwing or affecting authored capabilities", () => {
    for (const value of [null, [], "unsupported", true]) {
      expect(states({ ...profile(), templating: value })).toEqual(["disabled", "enabled", "enabled"]);
    }
  });

  it("keeps normalized evidence bounded, detached and content-free", () => {
    const value = { ...profile(), secret: "tok_PRIVATE_PAYLOAD" };
    const parsed = parseProfile(value);
    expect(JSON.stringify(parsed)).not.toContain("tok_PRIVATE_PAYLOAD");
    expect(parsed.reasons.length).toBeLessThanOrEqual(12);
    const good = profile(); const p = parseProfile(good);
    (good.elements as string[]).push("Image");
    expect([...p.display.elements]).not.toContain("Image");
    expect(Object.isFrozen(p)).toBe(true);
    expect("add" in p.display.elements).toBe(false);
  });
});

describe("display element intersection (D-W2 Option A, display only)", () => {
  const live = () => projectCardProfile(liveProfileJson() as unknown as JsonValue);

  it("the live profile enables display with exactly its known elements; interaction stays disabled", () => {
    const p = parseProfile(live());
    expect(p.display.state).toBe("enabled");
    expect([...p.display.elements].sort()).toEqual(["ActionSet", "ColumnSet", "Container", "FactSet", "RichTextBlock", "Table", "TextBlock"]);
    expect(p.interaction.state).toBe("disabled");
    expect(p.reasons).toContain("profile_incompatible");
  });

  it("interaction stays disabled with Action.Submit added while the unknown Image elements remain", () => {
    const body = liveProfileJson() as unknown as { actions: string[] };
    body.actions.push("Action.Submit");
    const p = parseProfile(projectCardProfile(body as unknown as JsonValue));
    expect(p.display.state).toBe("enabled");
    expect(p.interaction.state).toBe("disabled");
  });

  it("unknown elements plus TextBlock give display exactly TextBlock; unknown elements are never negotiated", () => {
    const p = parseProfile(profile({ elements: ["Image", "TextBlock", "ImageSet", "Media"] }));
    expect(p.display.state).toBe("enabled");
    expect([...p.display.elements]).toEqual(["TextBlock"]);
  });

  it("a profile without TextBlock or with an unknown action keeps display disabled", () => {
    const noText = liveProfileJson() as unknown as { elements: string[] };
    noText.elements = noText.elements.filter((e) => e !== "TextBlock");
    expect(parseProfile(projectCardProfile(noText as unknown as JsonValue)).display.state).toBe("disabled");
    const unknownAction = liveProfileJson() as unknown as { actions: string[] };
    unknownAction.actions.push("Action.Execute");
    expect(parseProfile(projectCardProfile(unknownAction as unknown as JsonValue)).display.state).toBe("disabled");
  });

  it("automatic is unaffected by the element list", () => {
    expect(parseProfile(profile({ elements: ["Image"] })).automatic.state).toBe("enabled");
    expect(parseProfile(profile({ elements: ["TextBlock", "Image"] })).automatic).toEqual(parseProfile(profile()).automatic);
  });
});

describe("display action subset (advertised local actions only)", () => {
  const actions = (value: unknown) => [...parseProfile(value).display.actions].sort();

  it("carries exactly the advertised local actions; Action.Submit is never a display action", () => {
    expect(actions(profile())).toEqual(["Action.CopyToClipboard", "Action.OpenUrl", "Action.ToggleVisibility"]);
    expect(actions(profile({ actions: ["Action.OpenUrl"] }))).toEqual(["Action.OpenUrl"]);
    expect(actions(profile({ actions: ["Action.Submit", "Action.CopyToClipboard"] }))).toEqual(["Action.CopyToClipboard"]);
    expect(actions(profile({ actions: [] }))).toEqual([]);
    expect(parseProfile(profile({ actions: [] })).display.state).toBe("enabled");
  });

  it("the live profile's OpenUrl-only action list negotiates OpenUrl only", () => {
    const body = liveProfileJson() as unknown as { actions: string[] };
    body.actions = ["Action.OpenUrl"];
    const p = parseProfile(projectCardProfile(body as unknown as JsonValue));
    expect(p.display.state).toBe("enabled");
    expect([...p.display.actions]).toEqual(["Action.OpenUrl"]);
  });

  it("disabled or failed display carries no actions; an unknown action still fails the profile closed", () => {
    expect(actions(profile({ actions: ["Action.OpenUrl", "Action.Unknown"] }))).toEqual([]);
    expect(parseProfile(profile({ actions: ["Action.OpenUrl", "Action.Unknown"] })).display.state).toBe("disabled");
    expect(actions(profile({ config: { ...profile().config!, display_enabled: false } }))).toEqual([]);
    expect(actions(undefined)).toEqual([]);
    expect("add" in parseProfile(profile()).display.actions).toBe(false);
    expect(negotiate(parseProfile(profile({ actions: ["Action.OpenUrl"] })), { display: false }).display.actions.size).toBe(1);
  });

  it("interaction negotiation is unchanged by the display action subset", () => {
    const view = (i: ReturnType<typeof parseProfile>["interaction"]) => ({ ...i, inputs: [...i.inputs] });
    expect(view(parseProfile(profile({ actions: ["Action.OpenUrl", "Action.Submit"] })).interaction))
      .toEqual(view(parseProfile(profile()).interaction));
    expect(parseProfile(profile({ actions: ["Action.OpenUrl"] })).interaction.state).toBe("disabled");
  });
});

describe("pinned control-free template", () => {
  it("selects exactly one server-selected id/version with the approved views", () => {
    const p = profile(); const selected = selectTemplate(p);
    expect(selected).toEqual({ id: "ai.reasoning-process", version: "0.4.0", controlFree: true,
      views: { active: { view: "active", version: "octo/v2", controlFree: true },
        error: { view: "error", version: "octo/v2", controlFree: true },
        result: { view: "result", version: "octo/v1", controlFree: true } } });
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it.each(["id", "version", "duplicate", "missing", "wire", "unsupported", "extra_view", "extra_state",
    "missing_state", "view_version", "duplicate_view", "stop", "retry", "result_submit"])("rejects template defect %s independently", (defect) => {
    const p = { ...structuredClone(profile()) };
    const t = p.templating!; const templates = [...t.templates!]; const tpl = templates[0];
    const views = tpl.views.map(v => ({ ...v, states: [...v.states], submit_actions: [...v.submit_actions] }));
    if (defect === "id") p.config = { ...p.config!, reasoning_template_ref: { id: "foreign", version: tpl.version } };
    if (defect === "version") p.config = { ...p.config!, reasoning_template_ref: { id: tpl.id, version: "0.4.1" } };
    if (defect === "duplicate") templates.push(tpl);
    if (defect === "extra_view") views.push({ ...views[0], name: "extra" });
    if (defect === "extra_state") views[0].states.push("unknown");
    if (defect === "missing_state") views[0].states.pop();
    if (defect === "view_version") views[0].wire_profile = "octo/v1";
    if (defect === "duplicate_view") views[2] = views[0];
    if (defect === "stop") views[0].submit_actions.push("reasoning_stop");
    if (defect === "retry") views[1].submit_actions.push("reasoning_retry");
    if (defect === "result_submit") views[2].submit_actions.push("submit");
    templates[0] = { ...tpl, views };
    if (defect === "missing") templates.length = 0;
    p.templating = { ...t, templates, ...(defect === "wire" ? { wire: "other" } : {}),
      ...(defect === "unsupported" ? { supported: false } : {}) };
    expect(states(p)).toEqual(["disabled", "enabled", "enabled"]);
  });
});

describe("pure conservative limits and measurement", () => {
  const keys = ["max_nodes", "max_depth", "max_payload_bytes", "max_input_text_bytes", "max_inputs_bytes"] as const;
  it.each(keys)("requires finite positive safe integers for %s", key => {
    for (const bad of [-1, 0, 1.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null, true]) {
      const p = parseProfile(profile({ limits: { [key]: bad } } as unknown as Parameters<typeof profile>[0]));
      expect([p.automatic.state, p.display.state, p.interaction.state]).not.toEqual(ON);
    }
    for (const good of [1, Number.MAX_SAFE_INTEGER]) expect(normalizeLimits({ [key]: good }).valid).toBe(true);
  });
  it("narrows server and pinned bounds independently and never enlarges existing cards", () => {
    const server = normalizeLimits({ max_nodes: 199, max_depth: 11, max_payload_bytes: 16383,
      max_input_text_bytes: 4095, max_inputs_bytes: 16383 }).limits;
    const pinned = normalizeLimits({ max_nodes: 100, max_depth: 6, max_payload_bytes: 1000,
      max_input_text_bytes: 100, max_inputs_bytes: 500 }).limits;
    expect(effectiveLimits(server, pinned)).toEqual(pinned);
    expect(effectiveLimits(pinned, server)).toEqual(pinned);
    expect(normalizeLimits(Object.fromEntries(keys.map(k => [k, Number.MAX_SAFE_INTEGER]))).limits)
      .toEqual(normalizeLimits(undefined).limits);
  });
  it("rejects forged/prototype-bearing effective limits", () => {
    const good = normalizeLimits(undefined).limits;
    for (const bad of [Object.create(good) as typeof good, { ...good, maxNodes: NaN },
      { ...good, maxDepth: 0 }, { ...good, extra: true }]) {
      expect(() => effectiveLimits(bad)).toThrow("invalid_card_limits");
      expect(() => effectiveLimits(good, bad)).toThrow("invalid_card_limits");
    }
  });
  it.each(["sourceBlocks", "nodes", "depth", "buttons", "inputs", "sectionOptions"] as const)("checks below/exact/above %s", key => {
    const cap = CARD_BOUNDS[key];
    expect(withinCount(cap - 1, cap)).toBe(true);
    expect(withinCount(cap, cap)).toBe(true);
    expect(withinCount(cap + 1, cap)).toBe(false);
    expect(withinCount(1.1, cap)).toBe(false);
    expect(withinCount(-1, cap)).toBe(false);
  });
  it("counts UTF-8 and Unicode scalars separately with no invalid surrogate repair", () => {
    for (const n of [4095, 4096, 4097]) expect(withinUtf8("x".repeat(n), 4096)).toBe(n <= 4096);
    expect(withinUtf8("😀".repeat(1024), 4096)).toBe(true);
    expect(withinUtf8("😀".repeat(1024) + "x", 4096)).toBe(false);
    for (const n of [279, 280, 281]) expect(withinScalars("😀".repeat(n), 280)).toBe(n <= 280);
    expect(withinUtf8("\ud800", 4096)).toBe(false);
    expect(withinScalars("\udc00", 280)).toBe(false);
  });
  it("measures full serialized envelopes, bounded structural depth and node counts", () => {
    for (const n of [16383, 16384, 16385]) {
      const envelope = { plain: "x".repeat(n - 12) };
      expect(measureEnvelope(envelope)).toBe(n);
    }
    expect(measureStructure({ a: {} })).toEqual({ nodes: 2, depth: 2 });
    expect(measureEnvelope({ n: NaN })).toBeUndefined();
    expect(measureEnvelope({ n: undefined })).toBeUndefined();
    expect(measureEnvelope(Object.create({ secret: "x" }))).toBeUndefined();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(measureStructure(cyclic)).toBeUndefined();
    expect(measureEnvelope(cyclic)).toBeUndefined();
  });

  it("checks actual nested node and depth edges and total envelope/submission byte edges", () => {
    for (const count of [199, 200, 201]) {
      const value = { children: Array.from({ length: count - 2 }, () => ({})) };
      expect(withinCount(measureStructure(value)!.nodes, 200)).toBe(count <= 200);
    }
    for (const depth of [11, 12, 13]) {
      let value: object = {};
      for (let i = 1; i < depth; i++) value = { child: value };
      expect(withinCount(measureStructure(value)!.depth, 12)).toBe(depth <= 12);
    }
    for (const size of [16383, 16384, 16385]) {
      expect(withinCount(measureEnvelope({ plain: "x".repeat(size - 12) })!, 16384)).toBe(size <= 16384);
      expect(withinUtf8("x".repeat(size), 16384)).toBe(size <= 16384);
    }
  });
});
