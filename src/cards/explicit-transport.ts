/**
 * Explicit transport (WP-09): the host's `ExplicitTransport` over the Bot's
 * own Card API client, policy and origin pacer.
 *
 * The host has already reserved the request (slot, `clientMsgNo`, card row)
 * and owns every result code; this module only reports what happened to the
 * one send it is handed:
 * - `failed` is reported only when nothing can have been dispatched: the
 *   transport's own checks before calling `sendAuthored` (abort, pinned
 *   re-authorization, refitted envelope, current element and action sets,
 *   origin gate),
 *   or a definite contract/policy rejection (400/404/422, 401/403) of the
 *   request;
 * - `acked` only for a validated `SendAck`;
 * - everything else, including an abort or timeout once the request was
 *   issued, is `ambiguous`. An abort raised inside `sendAuthored` is never
 *   taken as proof that nothing was sent.
 *
 * It never retries, never mints a `clientMsgNo` and never waits for the
 * origin gate: an ineligible origin fails fast, provably unsent, and the
 * reserved slot stays consumed (32/10, no refund).
 */
import {
  CARD_API_DEADLINE_MS, CARD_ENVELOPE_MAX_BYTES, CardRequestError, OctoApiError, classifySendFailure, serializeSendAuthored, serializeSendInformational,
  type CardApi, type SendAuthoredRequest, type SendInformationalRequest,
} from "./api.js";
import type { AcDisplayElement, Limits, MonotonicClock, PolicySnapshot } from "./contracts.js";
import type { DisplayExplicitCard } from "./explicit-display.js";
import { interactionDegradation, type InteractiveExplicitCard } from './explicit-interactive.js';
import type { AcInteractiveElement, InputKind } from './contracts.js';
import type { Pacer } from "./pacer.js";
import type { CardPolicy } from "./policy.js";
import type { ExplicitTransport, ExplicitTransportOutcome } from "./tool-host.js";

export interface ExplicitTransportOptions {
  readonly api: Pick<CardApi, "origin" | "sendAuthored"> & Partial<Pick<CardApi, 'sendInformational'>>;
  readonly pacer: Pick<Pacer, "gate" | "observe429" | "observeSuccess">;
  readonly policy: Pick<CardPolicy, "authorize"> & Partial<Pick<CardPolicy, 'snapshot'>>;
  readonly clock: MonotonicClock;
}

const FAILED: ExplicitTransportOutcome = Object.freeze({ kind: "failed" });
const AMBIGUOUS: ExplicitTransportOutcome = Object.freeze({ kind: "ambiguous" });

/** The layout limits the card was fitted under; undefined when unreadable. */
function builtLimits(card: DisplayExplicitCard | InteractiveExplicitCard): Pick<Limits, "maxNodes" | "maxDepth"> | undefined {
  try {
    const l = JSON.parse(card.pinnedLimitsJson ?? "") as Partial<Limits>;
    return Number.isSafeInteger(l.maxNodes) && Number.isSafeInteger(l.maxDepth)
      ? { maxNodes: l.maxNodes as number, maxDepth: l.maxDepth as number } : undefined;
  } catch {
    return undefined;
  }
}

function inputsSupported(body: readonly AcInteractiveElement[], inputs: ReadonlySet<InputKind>): boolean {
  const kinds: Record<string, InputKind> = { 'Input.Text': 'text', 'Input.Number': 'number', 'Input.Date': 'date', 'Input.Time': 'time', 'Input.Toggle': 'toggle', 'Input.ChoiceSet': 'choice' };
  return body.every(e => {
    if (e.type === 'Container') return inputsSupported(e.items, inputs);
    if (e.type === 'TextBlock' || e.type === 'FactSet') return true;
    return inputs.has(kinds[e.type]);
  });
}

/**
 * Whether every element of the display body, nested ones included, is in the
 * current display element set and every ActionSet action is in the current
 * advertised action set. Walks the closed `octo/v1` display union only: any
 * other type is unsupported, and a malformed child list throws (failed).
 */
function bodySupported(body: readonly AcDisplayElement[], display: PolicySnapshot["display"]): boolean {
  const { elements, actions } = display;
  const all = (items: readonly AcDisplayElement[]): boolean => items.every(one);
  const one = (e: AcDisplayElement): boolean => {
    if (!elements.has(e.type)) return false;
    switch (e.type) {
      case "TextBlock": case "RichTextBlock": case "FactSet": return true;
      case "ActionSet": return Array.isArray(e.actions) && e.actions.every((a) => actions.has(a.type));
      case "Container": return all(e.items);
      case "ColumnSet": return e.columns.every((c) => all(c.items));
      case "Table": return e.rows.every((r) => r.cells.every((c) => all(c.items)));
      default: return false;
    }
  };
  return all(body);
}

export function createExplicitTransport(options: ExplicitTransportOptions): ExplicitTransport {
  const { api, pacer, policy, clock } = options;
  return Object.freeze({
    async send(input: Parameters<ExplicitTransport["send"]>[0]): Promise<ExplicitTransportOutcome> {
      // ── pre-request: nothing below can have reached the server ──
      let request: SendAuthoredRequest;
      let informational: SendInformationalRequest | undefined;
      try {
        if (input.signal.aborted) return FAILED;
        if (input.card.informational === true) {
          const card = input.card;
          if (card.opcode !== 'interactive') return FAILED;
          const snapshot = await policy.snapshot?.();
          if (snapshot === undefined || snapshot.botRef.originKey !== input.ctx.botRef.originKey || snapshot.botRef.credentialRef !== input.ctx.botRef.credentialRef
            || interactionDegradation(snapshot) !== card.reason || api.sendInformational === undefined || input.signal.aborted) return FAILED;
          informational = { route: { channelId: card.binding.channelId, channelType: card.binding.channelType }, clientMsgNo: input.clientMsgNo, plain: card.plain,
            maxEnvelopeBytes: Math.min(snapshot.interaction.limits.maxPayloadBytes, CARD_ENVELOPE_MAX_BYTES) };
          serializeSendInformational(informational);
        } else {
        const card = input.card as DisplayExplicitCard | InteractiveExplicitCard;
        if (card.snapshot === undefined || card.authored === undefined || typeof card.plain !== 'string') return FAILED;
        if (card.opcode !== 'display' && (card.opcode !== 'interactive' || card.authored.profile !== 'octo/v2' || !card.contract || card.contract.requesterUid !== input.ctx.requesterUid)) return FAILED;
        // The snapshot the card was built from, re-authorized pinned: a revoked or refreshed-away policy is no send.
        const auth = policy.authorize(card.opcode === 'display' ? 'display' : 'interaction', { botRef: input.ctx.botRef }, card.snapshot);
        if (!auth.allowed) return FAILED;
        const built = builtLimits(card);
        if (built === undefined || auth.limits.maxNodes < built.maxNodes || auth.limits.maxDepth < built.maxDepth) return FAILED;
        request = Object.freeze({ profile: card.authored.profile, card: card.authored.card,
          route: Object.freeze({ channelId: card.binding.channelId, channelType: card.binding.channelType }),
          clientMsgNo: input.clientMsgNo, plain: card.plain,
          maxEnvelopeBytes: Math.min(auth.limits.maxPayloadBytes, CARD_ENVELOPE_MAX_BYTES) }) as SendAuthoredRequest;
        // Refit against the current effective payload limit; throws before any fetch.
        serializeSendAuthored(request);
        // Element- or action-set shrink: the current sets must still carry everything the card was built with.
        if (card.opcode === 'display') {
          if (!bodySupported(card.authored.card.body, auth.snapshot.display)) return FAILED;
        } else if (!inputsSupported(card.authored.card.body, auth.snapshot.interaction.inputs)) return FAILED;
        }
        if (!pacer.gate(api.origin).eligible) return FAILED;
      } catch {
        return FAILED;
      }

      // ── the one request ──
      let messageId: string;
      try {
        const ack = informational !== undefined
          ? await api.sendInformational!(informational, { signal: input.signal, deadlineMs: CARD_API_DEADLINE_MS })
          : await api.sendAuthored(request!, { signal: input.signal, deadlineMs: CARD_API_DEADLINE_MS });
        messageId = ack.messageId;
      } catch (err) {
        if (err instanceof OctoApiError && err.transport === "response" && err.status === 429) {
          try { pacer.observe429(api.origin, err.retryAfterMs, clock.nowMono()); } catch { /* timing only */ }
        }
        const cls = err instanceof OctoApiError || err instanceof CardRequestError ? classifySendFailure(err) : "ambiguous";
        return cls === "ambiguous" ? AMBIGUOUS : FAILED;
      }
      try { pacer.observeSuccess(api.origin); } catch { /* timing only */ }
      return Object.freeze({ kind: "acked", messageId });
    },
  });
}
