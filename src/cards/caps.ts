/** Local preferences can only narrow normalized server permission. No config parsing. */
import type { NormalizedProfile } from "./profile-parse.js";
import type { SafeReasonCode } from "./contracts.js";

export interface LocalNarrowing { readonly automatic?: boolean; readonly display?: boolean; readonly interaction?: boolean }
export type Capabilities = NormalizedProfile;
export function negotiate(profile: NormalizedProfile, localNarrowing: LocalNarrowing = {}): Capabilities {
  const narrowed = localNarrowing.automatic === false || localNarrowing.display === false || localNarrowing.interaction === false;
  return Object.freeze({
    automatic: localNarrowing.automatic === false ? Object.freeze({ state: "disabled" as const, maxPayloadBytes: profile.automatic.maxPayloadBytes }) : profile.automatic,
    display: localNarrowing.display === false ? Object.freeze({ ...profile.display, state: "disabled" as const }) : profile.display,
    interaction: localNarrowing.interaction === false ? Object.freeze({ ...profile.interaction, state: "disabled" as const }) : profile.interaction,
    reasons: Object.freeze([...new Set<SafeReasonCode>([...profile.reasons, ...(narrowed ? ["local_disabled" as const] : [])])]),
  });
}
