/** Fail-closed interpretation of the projected WP-01 profile; never retains raw data. */
import type { CapabilityState, CardProfileWire, DisplayActionKind, InputKind, PolicySnapshot, SafeReasonCode } from "./contracts.js";
import { closedRecord, measureStructure, normalizeLimits, profileString, stringList } from "./limits.js";
import { selectTemplate } from "./template.js";

export type NormalizedProfile = Pick<PolicySnapshot, "automatic" | "display" | "interaction" | "reasons">;
const KEYS = ["available", "enabled", "profiles", "card_version", "elements", "inputs", "actions", "limits", "templating", "config"];
const CONFIG_KEYS = ["card_enabled", "reasoning_enabled", "reasoning_template_ref", "display_enabled", "interaction_enabled"];
const ELEMENTS = ["TextBlock", "RichTextBlock", "FactSet", "Container", "ColumnSet", "Table", "ActionSet"];
const ACTIONS = ["Action.OpenUrl", "Action.ToggleVisibility", "Action.CopyToClipboard", "Action.Submit"];
/** The local actions a display card may carry; Action.Submit is interaction only. */
const DISPLAY_ACTIONS: readonly DisplayActionKind[] = ["Action.OpenUrl", "Action.ToggleVisibility", "Action.CopyToClipboard"];
const INPUTS: Readonly<Record<string, InputKind>> = Object.freeze({ "Input.Text": "text", "Input.Number": "number",
  "Input.Date": "date", "Input.Time": "time", "Input.Toggle": "toggle", "Input.ChoiceSet": "choice" });

/** ReadonlySet facade: Object.freeze(Set) alone would still permit mutation. */
export function readonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const set = new Set(values);
  const facade: ReadonlySet<T> = Object.freeze({
    get size() { return set.size; },
    has: (value: T) => set.has(value), entries: () => set.entries(), keys: () => set.keys(),
    values: () => set.values(), [Symbol.iterator]: () => set.values(),
    forEach: (callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown) => {
      set.forEach(value => callback.call(thisArg, value, value, facade));
    },
  });
  return facade;
}

export function disabledProfile(reason: SafeReasonCode, state: CapabilityState = "disabled"): NormalizedProfile {
  const limits = normalizeLimits(undefined).limits;
  return Object.freeze({ automatic: Object.freeze({ state, maxPayloadBytes: limits.maxPayloadBytes }),
    display: Object.freeze({ state, elements: readonlySet<string>([]), actions: readonlySet<DisplayActionKind>([]), limits }),
    interaction: Object.freeze({ state, inputs: readonlySet<InputKind>([]), limits }),
    reasons: Object.freeze([reason]) });
}
function allowedList(value: unknown, allowed: readonly string[]): value is readonly string[] {
  return stringList(value) && value.every(v => allowed.includes(v));
}
function strictConfig(value: unknown): value is NonNullable<CardProfileWire["config"]> {
  if (!closedRecord(value, CONFIG_KEYS) || Object.keys(value).length !== CONFIG_KEYS.length) return false;
  if ([value.card_enabled, value.reasoning_enabled, value.display_enabled, value.interaction_enabled]
    .some(v => typeof v !== "boolean")) return false;
  if (!value.card_enabled && (value.reasoning_enabled || value.display_enabled || value.interaction_enabled)) return false;
  const ref = value.reasoning_template_ref;
  if (value.reasoning_enabled) return closedRecord(ref, ["id", "version"])
    && Object.keys(ref).length === 2 && profileString(ref.id) && profileString(ref.version);
  return ref === null;
}

export function parseProfile(value: unknown): NormalizedProfile {
  try {
    if (measureStructure(value, true) === undefined || !closedRecord(value, KEYS)) return disabledProfile("profile_malformed");
    if ([value.available, value.enabled].some(v => v !== undefined && typeof v !== "boolean")) return disabledProfile("profile_malformed");
    if (!strictConfig(value.config)) return disabledProfile("config_inconsistent");
    if (value.limits !== undefined && !closedRecord(value.limits,
      ["max_nodes", "max_depth", "max_payload_bytes", "max_input_text_bytes", "max_inputs_bytes"])) return disabledProfile("profile_malformed");
    if (closedRecord(value.templating)) {
      if (!closedRecord(value.templating, ["supported", "wire", "templates"])) return disabledProfile("profile_malformed");
      if (Array.isArray(value.templating.templates)) {
        for (const t of value.templating.templates) {
          if (!closedRecord(t, ["id", "version", "views"])) return disabledProfile("profile_malformed");
          if (Array.isArray(t.views) && t.views.some(v => !closedRecord(v, ["name", "states", "wire_profile", "submit_actions"]))) {
            return disabledProfile("profile_malformed");
          }
        }
      }
    }
    const config = value.config;
    if (!config.card_enabled) return disabledProfile("capability_disabled");
    const limits = normalizeLimits(value.limits);
    const reasons = new Set<SafeReasonCode>();
    const template = selectTemplate(value as CardProfileWire);
    const auto = config.reasoning_enabled && typeof template !== "string" && limits.payloadValid;
    const profilesOK = allowedList(value.profiles, ["octo/v1", "octo/v2"]);
    const elementsOK = allowedList(value.elements, ELEMENTS) && value.elements.includes("TextBlock");
    const actionsOK = allowedList(value.actions, ACTIONS);
    const layoutOK = value.card_version === "1.5" && elementsOK && limits.payloadValid && limits.layoutValid;
    // Display only (D-W2 Option A): advertised elements outside the closed list are ignored, never negotiated or
    // emitted; TextBlock stays mandatory. Interaction keeps the strict list, and actions stay strict for both.
    const displayElements = stringList(value.elements) ? value.elements.filter(e => ELEMENTS.includes(e)) : [];
    const displayLayoutOK = value.card_version === "1.5" && displayElements.includes("TextBlock") && limits.payloadValid && limits.layoutValid;
    // Display carries exactly the advertised local actions (an unknown action has already failed `actionsOK`).
    const displayActions = actionsOK ? DISPLAY_ACTIONS.filter(a => (value.actions as readonly string[]).includes(a)) : [];
    const display = config.display_enabled && profilesOK && (value.profiles as readonly string[]).includes("octo/v1") && displayLayoutOK && actionsOK;
    const interaction = config.interaction_enabled && profilesOK && (value.profiles as readonly string[]).includes("octo/v2")
      && layoutOK && actionsOK && (value.actions as readonly string[]).includes("Action.Submit")
      && allowedList(value.inputs, Object.keys(INPUTS)) && limits.inputsValid;
    if (!config.reasoning_enabled || !config.display_enabled || !config.interaction_enabled) reasons.add("capability_disabled");
    if (config.reasoning_enabled && !auto) reasons.add(typeof template === "string" ? "template_incompatible" : "profile_incompatible");
    if ((config.display_enabled && !display) || (config.interaction_enabled && !interaction)) reasons.add("profile_incompatible");
    return Object.freeze({
      automatic: Object.freeze({ state: auto ? "enabled" : "disabled", ...(auto && typeof template !== "string" ? { template } : {}),
        maxPayloadBytes: limits.limits.maxPayloadBytes }),
      display: Object.freeze({ state: display ? "enabled" : "disabled", ...(display ? { profile: "octo/v1" as const, cardVersion: "1.5" as const } : {}),
        elements: readonlySet(display ? displayElements : []), actions: readonlySet(display ? displayActions : []), limits: limits.limits }),
      interaction: Object.freeze({ state: interaction ? "enabled" : "disabled", ...(interaction ? { profile: "octo/v2" as const, cardVersion: "1.5" as const } : {}),
        inputs: readonlySet(interaction ? (value.inputs as readonly string[]).map(k => INPUTS[k]) : []), limits: limits.limits }),
      reasons: Object.freeze([...reasons]),
    });
  } catch { return disabledProfile("profile_malformed"); }
}
