/**
 * Sanitized `GET /v1/bot/card/profile` body observed on 2026-10-26 against the
 * deployed server for the designated test bot (one read-only call, status 200).
 * Only the response body is kept: no token, bot id, route or account data.
 * `submit_actions` was recorded as a count of 0 and is restored as the empty
 * list the server always emits (octo-server `card_template_catalog.go`).
 */
export const LIVE_CARD_PROFILE_2026_10_26 = Object.freeze({
  enabled: true,
  profiles: ["octo/v1", "octo/v2"],
  card_version: "1.5",
  elements: ["TextBlock", "RichTextBlock", "Image", "ImageSet", "Container", "ColumnSet", "FactSet", "Table", "ActionSet"],
  inputs: ["Input.Text", "Input.Toggle", "Input.ChoiceSet", "Input.Number", "Input.Date", "Input.Time"],
  actions: ["Action.OpenUrl", "Action.ToggleVisibility", "Action.CopyToClipboard"],
  limits: { max_nodes: 200, max_depth: 16, max_payload_bytes: 524288, max_input_text_bytes: 4096, max_inputs_bytes: 16384 },
  templating: { supported: true, wire: "template-ref/v1", templates: [
    { id: "ai.reasoning-process", version: "0.4.1", views: [
      { name: "active", wire_profile: "octo/v2", states: ["answering", "reasoning"], submit_actions: [] },
      { name: "error", wire_profile: "octo/v2", states: ["error"], submit_actions: [] },
      { name: "result", wire_profile: "octo/v1", states: ["completed", "stopped"], submit_actions: [] },
    ] },
  ] },
  config: { card_enabled: true, reasoning_enabled: true, display_enabled: true, interaction_enabled: true,
    reasoning_template_ref: { id: "ai.reasoning-process", version: "0.4.1" } },
});

/** Fresh mutable deep copy of the live body, as raw JSON off the wire. */
export function liveProfileJson(): typeof LIVE_CARD_PROFILE_2026_10_26 {
  return structuredClone(LIVE_CARD_PROFILE_2026_10_26) as typeof LIVE_CARD_PROFILE_2026_10_26;
}
