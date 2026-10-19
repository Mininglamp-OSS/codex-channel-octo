import type { CardProfileWire } from "../../cards/contracts.js";

/** Synthetic contract fixture; no server discovery or live permission evidence. */
export function profile(overrides: Partial<CardProfileWire> = {}): CardProfileWire {
  return {
    config: { card_enabled: true, reasoning_enabled: true,
      reasoning_template_ref: { id: "ai.reasoning-process", version: "0.4.0" },
      display_enabled: true, interaction_enabled: true },
    profiles: ["octo/v1", "octo/v2"], card_version: "1.5",
    elements: ["TextBlock", "RichTextBlock", "FactSet", "Container", "ColumnSet", "Table", "ActionSet"],
    inputs: ["Input.Text", "Input.Number", "Input.Date", "Input.Time", "Input.Toggle", "Input.ChoiceSet"],
    actions: ["Action.OpenUrl", "Action.ToggleVisibility", "Action.CopyToClipboard", "Action.Submit"],
    templating: { supported: true, wire: "template-ref/v1", templates: [
      { id: "ai.reasoning-process", version: "0.4.0", views: [
        { name: "active", wire_profile: "v2", states: ["reasoning", "answering"], submit_actions: [] },
        { name: "error", wire_profile: "v2", states: ["error"], submit_actions: [] },
        { name: "result", wire_profile: "v1", states: ["completed", "stopped"], submit_actions: [] },
      ] },
    ] },
    ...overrides,
  };
}
