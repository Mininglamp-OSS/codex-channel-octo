/** Exact Registry selection, independent from authored profile negotiation. */
import type { CardProfileWire, PinnedTemplate, SafeReasonCode, ViewSpec } from "./contracts.js";
import { closedRecord, measureStructure, profileString, stringList } from "./limits.js";

const ID = "ai.reasoning-process";
const VIEW_CONTRACT = { active: { version: "v2", states: ["reasoning", "answering"] },
  error: { version: "v2", states: ["error"] }, result: { version: "v1", states: ["completed", "stopped"] } } as const;

export function selectTemplate(profile: CardProfileWire): PinnedTemplate | SafeReasonCode {
  const raw: unknown = profile;
  if (measureStructure(raw, true) === undefined || !closedRecord(raw)) return "template_incompatible";
  const ref = profile.config?.reasoning_template_ref;
  const t = profile.templating;
  if (!closedRecord(ref, ["id", "version"]) || ref.id !== ID || !profileString(ref.version)
    || !closedRecord(t, ["supported", "wire", "templates"]) || t.supported !== true || t.wire !== "template-ref/v1"
    || !Array.isArray(t.templates) || t.templates.length > 256) return "template_incompatible";
  const matches = t.templates.filter(candidate => closedRecord(candidate, ["id", "version", "views"])
    && candidate.id === ref.id && candidate.version === ref.version);
  if (matches.length !== 1) return "template_incompatible";
  const views: unknown = matches[0].views;
  if (!Array.isArray(views) || views.length !== 3) return "template_incompatible";
  const out: Partial<Record<keyof typeof VIEW_CONTRACT, ViewSpec>> = {};
  for (const view of views) {
    if (!closedRecord(view, ["name", "wire_profile", "states", "submit_actions"])) return "template_incompatible";
    const name = view.name;
    if (name !== "active" && name !== "error" && name !== "result") return "template_incompatible";
    const expected = VIEW_CONTRACT[name];
    if (out[name] || view.wire_profile !== expected.version || !stringList(view.states)
      || view.states.length !== expected.states.length || !expected.states.every(state => (view.states as readonly string[]).includes(state))
      || !Array.isArray(view.submit_actions) || view.submit_actions.length !== 0) return "template_incompatible";
    out[name] = Object.freeze({ view: name, version: expected.version, controlFree: true });
  }
  if (!out.active || !out.error || !out.result) return "template_incompatible";
  return Object.freeze({ id: ID, version: ref.version,
    views: Object.freeze({ active: out.active, error: out.error, result: out.result }), controlFree: true });
}
