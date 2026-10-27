/**
 * Explicit display op handler (WP-09): `ExplicitOpHandler<"display">`.
 *
 * The host has already authenticated, charged and grammar-checked the call
 * (D0–D4). This handler:
 * 1. fails closed on a route that is not an ordinary user conversation
 *    (WP09-PF N2: OBO, document-task and cron are refused here as well as by
 *    the runtime offer, and any inconsistent route fact is `invalid_route`);
 * 2. applies the display schema (normalization, safe links, mention
 *    neutralization, authored redaction);
 * 3. builds and fits the `octo/v1` card and its plain text against the
 *    display capabilities;
 * 4. hands exactly one card to `reserveAndSend` and returns the host's
 *    result unchanged.
 *
 * Reserve → transport → finish, `sent` only after the ACK, `send_unconfirmed`
 * on any unproven outcome and the 32/10 accounting all stay host-owned; the
 * handler never retries, resends or reinterprets a host result.
 */
import { createHash } from "node:crypto";
import type { CardChannelType, CardToolResult, DisplayCardArgs, JsonValue, Limits, PolicySnapshot, RouteKind, TrustedTurnContext } from "./contracts.js";
import { buildDisplayCard, type DisplayAuthored, type DisplayCapabilities } from "./display-builder.js";
import { validateDisplayArgs } from "./display-schema.js";
import { normalizeLimits } from "./limits.js";
import { readonlySet } from "./profile-parse.js";
import { canonicalJson } from "./protocol.js";
import type { CardBinding, ExplicitCard } from "./store.js";
import type { ExplicitOpContext, ExplicitOpHandler, ExplicitSendPort } from "./tool-host.js";

/** The reserved display card plus the exact authored body and plain text the transport sends. */
export type DisplayExplicitCard = Extract<ExplicitCard, { opcode: "display" }> & {
  readonly authored: DisplayAuthored;
  readonly plain: string;
  /** In memory only: the policy snapshot the card was fitted under, re-authorized pinned before the send. */
  readonly snapshot?: PolicySnapshot;
};

/** Display capabilities plus, when they came from a policy, the snapshot they were read from. */
export interface ExplicitDisplayCapabilities extends DisplayCapabilities {
  readonly snapshot?: PolicySnapshot;
}

export interface ExplicitDisplayOptions {
  /**
   * Display capabilities for this call; `undefined` (or a throw) means no
   * display card. Defaults to {@link BASELINE_DISPLAY_CAPABILITIES}.
   */
  readonly capabilities?: () => ExplicitDisplayCapabilities | undefined;
}

/**
 * Fallback capabilities until per-Bot negotiation is wired in.
 *
 * - Elements: TextBlock only, which every enabled display profile lists
 *   (`profile-parse.ts` requires it), so this part is a safe lower bound.
 * - Limits: the client defaults, which are the client *maxima*, not a
 *   guaranteed lower bound. Negotiated limits are `min(server, default)`,
 *   so a server advertising smaller limits would be exceeded. Before any
 *   transport is wired, the caller must supply the negotiated per-Bot limits
 *   (and elements); these defaults must not be relied on for a real send.
 *
 * The host's per-call policy check still decides whether display is allowed.
 */
export const BASELINE_DISPLAY_CAPABILITIES: DisplayCapabilities = Object.freeze({
  elements: readonlySet(["TextBlock"]),
  limits: normalizeLimits(undefined).limits,
});

const ROUTE_KINDS: Readonly<Record<CardChannelType, RouteKind>> = Object.freeze({ 1: "dm", 2: "group", 5: "topic" });

function error(code: Extract<CardToolResult, { status: "error" }>["error"]["code"], rule: string): CardToolResult {
  return Object.freeze({ status: "error", error: Object.freeze({ code, diagnostics: Object.freeze([Object.freeze({ path: "$", rule })]) }) });
}

const ROUTE_INELIGIBLE = error("invalid_route", "route_ineligible");
const ROUTE_INVALID = error("invalid_route", "route_invalid");
const NO_CAPABILITY = error("unavailable", "display_capability");
const CLOSED = error("unavailable", "explicit_authority_closed");

/** Trusted binding of the turn; null when any route fact is inconsistent. */
function bindingOf(ctx: TrustedTurnContext): CardBinding | null | "ineligible" {
  const e = ctx.routeEligibility;
  if (e === null || typeof e !== "object" || typeof e.obo !== "boolean" || typeof e.docTask !== "boolean" || typeof e.cron !== "boolean") return null;
  if (e.obo || e.docTask || e.cron) return "ineligible";
  const route = ctx.route;
  const type = route?.channelType as CardChannelType;
  if (typeof route?.channelId !== "string" || route.channelId === "" || !Object.hasOwn(ROUTE_KINDS, type) || ROUTE_KINDS[type] !== e.kind) return null;
  const topicScope = route.topicScope ?? null;
  if ((e.kind === "topic") !== (topicScope !== null) || (topicScope !== null && (typeof topicScope !== "string" || topicScope === ""))) return null;
  return Object.freeze({ sessionKey: ctx.sessionKey, channelId: route.channelId, channelType: type, topicScope,
    generation: ctx.turnGeneration, resetEpoch: ctx.resetEpoch });
}

function pinnedLimits(l: Limits): Limits {
  return { maxNodes: l.maxNodes, maxDepth: l.maxDepth, maxPayloadBytes: l.maxPayloadBytes,
    maxInputTextBytes: l.maxInputTextBytes, maxInputsBytes: l.maxInputsBytes };
}

export function createExplicitDisplay(options: ExplicitDisplayOptions = {}): ExplicitOpHandler<"display"> {
  const capabilities = options.capabilities ?? (() => BASELINE_DISPLAY_CAPABILITIES);
  return Object.freeze({
    op: "display" as const,
    async handle(args: DisplayCardArgs, c: ExplicitOpContext, send: ExplicitSendPort, signal: AbortSignal): Promise<CardToolResult> {
      if (signal.aborted) return CLOSED;
      const binding = bindingOf(c.ctx);
      if (binding === "ineligible") return ROUTE_INELIGIBLE;
      if (binding === null) return ROUTE_INVALID;
      let caps: ExplicitDisplayCapabilities | undefined;
      try { caps = capabilities(); } catch { caps = undefined; }
      if (caps === undefined) return NO_CAPABILITY;

      const schema = validateDisplayArgs(args);
      if (!schema.ok) return Object.freeze({ status: "error", error: schema.error });
      const built = buildDisplayCard(schema.value, { caps, route: { channelId: binding.channelId, channelType: binding.channelType } });
      if (!built.ok) return Object.freeze({ status: "error", error: built.error });

      const bodyDigest = createHash("sha256")
        .update(canonicalJson({ profile: built.authored.profile, card: built.authored.card, plain: built.plain } as unknown as JsonValue), "utf8")
        .digest("hex");
      const card: DisplayExplicitCard = Object.freeze({
        opcode: "display", binding, bodyDigest, profile: built.authored.profile,
        pinnedLimitsJson: JSON.stringify(pinnedLimits(caps.limits)), authored: built.authored, plain: built.plain,
        ...(caps.snapshot !== undefined ? { snapshot: caps.snapshot } : {}),
      });
      if (signal.aborted) return CLOSED;
      return send.reserveAndSend(card);
    },
  });
}

/** The production display handler (registered in `PRODUCTION_EXPLICIT_OPS`). */
export const EXPLICIT_DISPLAY: ExplicitOpHandler<"display"> = createExplicitDisplay();
