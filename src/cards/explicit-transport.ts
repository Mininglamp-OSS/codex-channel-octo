/**
 * Explicit display transport (WP-09 wiring): the host's `ExplicitTransport`
 * over this Bot's existing `CardApi.sendAuthored`, policy and origin pacer.
 *
 * The host has already reserved the slot (32/10 accounting, no refund) and
 * minted the `clientMsgNo`; this module performs exactly one request and
 * never retries or resends.
 *
 * Prechecks, all before any request (so a refusal is provably unsent →
 * `failed`):
 * 1. the card is a display card carrying the built authored body, plain text
 *    and the policy snapshot it was built against;
 * 2. the pinned snapshot is re-authorized for display (same policy
 *    generation, no display revocation since), and the card is refit against
 *    the effective limits `min(current, pinned)` and the current element set,
 *    so a card built under one snapshot is never sent under a narrower one;
 * 3. the shared origin pacer gate is checked synchronously.
 *
 * Outcomes of the single `sendAuthored` call:
 * - a valid ACK → `acked` (and `observeSuccess`);
 * - any throw that `classifySendFailure` proves contract (400/404/422, or a
 *   client-side request rejection) or policy (401/403) → `failed`;
 * - everything else, abort included, → `ambiguous`. An abort is never taken
 *   as proof that the request was not dispatched.
 * A 429 is reported to the pacer (`observe429`) and stays ambiguous.
 */
import { CARD_ENVELOPE_MAX_BYTES, CARD_MAX_DEPTH, CARD_MAX_NODES, CardRequestError, OctoApiError, classifySendFailure, type CardApi } from "./api.js";
import type { AcDisplayElement, DisplayAdaptiveCard, MonotonicClock } from "./contracts.js";
import { measureDisplayCard } from "./display-builder.js";
import type { DisplayExplicitCard } from "./explicit-display.js";
import type { NormalizedOrigin } from "./origin.js";
import type { CardPolicy } from "./policy.js";
import type { ExplicitTransport, ExplicitTransportOutcome } from "./tool-host.js";

/** The shared origin pacer's timing surface (structurally `Pacer`; the pacer module stays private to the runtime). */
export interface ExplicitPacerPort {
  gate(origin: NormalizedOrigin): { readonly eligible: boolean };
  observe429(origin: NormalizedOrigin, retryAfterMs: number | undefined, receiptMono: number): void;
  observeSuccess(origin: NormalizedOrigin): void;
}

export interface ExplicitTransportOptions {
  readonly api: Pick<CardApi, "origin" | "sendAuthored">;
  readonly policy: Pick<CardPolicy, "authorize">;
  readonly pacer: ExplicitPacerPort;
  readonly clock: MonotonicClock;
}

const FAILED: ExplicitTransportOutcome = Object.freeze({ kind: "failed" });
const AMBIGUOUS: ExplicitTransportOutcome = Object.freeze({ kind: "ambiguous" });

/** Every element type of a display card body, nested ones included. */
function elementTypes(card: Pick<DisplayAdaptiveCard, "body">): Set<string> {
  const types = new Set<string>();
  const visit = (e: AcDisplayElement): void => {
    types.add(e.type);
    switch (e.type) {
      case "Container": for (const item of e.items) visit(item); break;
      case "ColumnSet": for (const c of e.columns) for (const item of c.items) visit(item); break;
      case "Table": for (const row of e.rows) for (const cell of row.cells) for (const item of cell.items) visit(item); break;
      default: break;
    }
  };
  for (const e of card.body) visit(e);
  return types;
}

function isDisplayCard(card: unknown): card is DisplayExplicitCard {
  if (card === null || typeof card !== "object") return false;
  const c = card as Partial<DisplayExplicitCard>;
  return c.opcode === "display" && c.profile === "octo/v1" && typeof c.plain === "string" && c.snapshot !== undefined
    && c.authored !== undefined && c.authored.profile === "octo/v1" && Array.isArray(c.authored.card?.body);
}

export function createExplicitTransport(options: ExplicitTransportOptions): ExplicitTransport {
  const { api, policy, pacer, clock } = options;
  return Object.freeze({
    async send(input: Parameters<ExplicitTransport["send"]>[0]): Promise<ExplicitTransportOutcome> {
      // ── prechecks: nothing below has reached the network ──
      let maxEnvelopeBytes: number;
      let card: DisplayExplicitCard;
      try {
        if (!isDisplayCard(input.card)) return FAILED;
        card = input.card;
        const auth = policy.authorize("display", { botRef: input.ctx.botRef }, card.snapshot);
        if (!auth.allowed) return FAILED;
        const elements = auth.snapshot.display.elements;
        for (const type of elementTypes(card.authored.card)) if (!elements.has(type)) return FAILED;
        const m = measureDisplayCard(card.authored.card);
        if (m.nodes > Math.min(auth.limits.maxNodes, CARD_MAX_NODES) || m.depth > Math.min(auth.limits.maxDepth, CARD_MAX_DEPTH)) return FAILED;
        maxEnvelopeBytes = Math.min(auth.limits.maxPayloadBytes, CARD_ENVELOPE_MAX_BYTES);
        if (!pacer.gate(api.origin).eligible) return FAILED;
      } catch {
        return FAILED;
      }

      // ── the single request ──
      try {
        const ack = await api.sendAuthored({ profile: card.authored.profile, card: card.authored.card,
          route: { channelId: card.binding.channelId, channelType: card.binding.channelType },
          clientMsgNo: input.clientMsgNo, plain: card.plain, maxEnvelopeBytes }, { signal: input.signal });
        try { pacer.observeSuccess(api.origin); } catch { /* timing only */ }
        // The host re-validates the id; anything unusable is unconfirmed, never resent.
        if (typeof ack?.messageId !== "string" || ack.messageId.length === 0) return AMBIGUOUS;
        return Object.freeze({ kind: "acked", messageId: ack.messageId });
      } catch (err) {
        if (err instanceof OctoApiError && err.transport === "response" && err.status === 429) {
          try { pacer.observe429(api.origin, err.retryAfterMs, clock.nowMono()); } catch { /* timing only */ }
        }
        if (!(err instanceof OctoApiError) && !(err instanceof CardRequestError)) return AMBIGUOUS;
        return classifySendFailure(err) === "ambiguous" ? AMBIGUOUS : FAILED;
      }
    },
  });
}
