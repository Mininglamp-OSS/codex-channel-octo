/**
 * Explicit transport (WP-09): the host's `ExplicitTransport` over the Bot's
 * own Card API client, policy and origin pacer.
 *
 * The host has already reserved the request (slot, `clientMsgNo`, card row)
 * and owns every result code; this module only reports what happened to the
 * one send it is handed:
 * - `failed` is reported only when nothing can have been dispatched: the
 *   transport's own checks before calling `sendAuthored` (abort, pinned
 *   re-authorization, refitted envelope, current element set, origin gate),
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
  CARD_API_DEADLINE_MS, CARD_ENVELOPE_MAX_BYTES, CardRequestError, OctoApiError, classifySendFailure, serializeSendAuthored,
  type CardApi, type SendAuthoredRequest,
} from "./api.js";
import type { AcDisplayElement, Limits, MonotonicClock } from "./contracts.js";
import type { DisplayExplicitCard } from "./explicit-display.js";
import type { Pacer } from "./pacer.js";
import type { CardPolicy } from "./policy.js";
import type { ExplicitTransport, ExplicitTransportOutcome } from "./tool-host.js";

export interface ExplicitTransportOptions {
  readonly api: Pick<CardApi, "origin" | "sendAuthored">;
  readonly pacer: Pick<Pacer, "gate" | "observe429" | "observeSuccess">;
  readonly policy: Pick<CardPolicy, "authorize">;
  readonly clock: MonotonicClock;
}

const FAILED: ExplicitTransportOutcome = Object.freeze({ kind: "failed" });
const AMBIGUOUS: ExplicitTransportOutcome = Object.freeze({ kind: "ambiguous" });

/** The layout limits the card was fitted under; undefined when unreadable. */
function builtLimits(card: DisplayExplicitCard): Pick<Limits, "maxNodes" | "maxDepth"> | undefined {
  try {
    const l = JSON.parse(card.pinnedLimitsJson ?? "") as Partial<Limits>;
    return Number.isSafeInteger(l.maxNodes) && Number.isSafeInteger(l.maxDepth)
      ? { maxNodes: l.maxNodes as number, maxDepth: l.maxDepth as number } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether every element of the display body, nested ones included, is in the
 * current display element set. Walks the closed `octo/v1` display union only:
 * any other type is unsupported, and a malformed child list throws (failed).
 */
function elementsSupported(body: readonly AcDisplayElement[], elements: ReadonlySet<string>): boolean {
  const all = (items: readonly AcDisplayElement[]): boolean => items.every(one);
  const one = (e: AcDisplayElement): boolean => {
    if (!elements.has(e.type)) return false;
    switch (e.type) {
      case "TextBlock": case "RichTextBlock": case "FactSet": case "ActionSet": return true;
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
      try {
        const card = input.card as DisplayExplicitCard;
        if (card.opcode !== "display" || card.snapshot === undefined || card.authored === undefined || typeof card.plain !== "string") return FAILED;
        if (input.signal.aborted) return FAILED;
        // The snapshot the card was built from, re-authorized pinned: a revoked or refreshed-away policy is no send.
        const auth = policy.authorize("display", { botRef: input.ctx.botRef }, card.snapshot);
        if (!auth.allowed) return FAILED;
        const built = builtLimits(card);
        if (built === undefined || auth.limits.maxNodes < built.maxNodes || auth.limits.maxDepth < built.maxDepth) return FAILED;
        request = Object.freeze({ profile: card.authored.profile, card: card.authored.card,
          route: Object.freeze({ channelId: card.binding.channelId, channelType: card.binding.channelType }),
          clientMsgNo: input.clientMsgNo, plain: card.plain,
          maxEnvelopeBytes: Math.min(auth.limits.maxPayloadBytes, CARD_ENVELOPE_MAX_BYTES) }) as SendAuthoredRequest;
        // Refit against the current effective payload limit; throws before any fetch.
        serializeSendAuthored(request);
        // Element-set shrink: the current set must still carry every element the card was built with.
        if (!elementsSupported(card.authored.card.body, auth.snapshot.display.elements)) return FAILED;
        if (!pacer.gate(api.origin).eligible) return FAILED;
      } catch {
        return FAILED;
      }

      // ── the one request ──
      let messageId: string;
      try {
        const ack = await api.sendAuthored(request, { signal: input.signal, deadlineMs: CARD_API_DEADLINE_MS });
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
