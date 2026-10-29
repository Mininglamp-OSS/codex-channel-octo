/** WP10 op handler. Host owns all reservation, accounting, transport and ACK results. */
import { createHash } from 'node:crypto';
import { serializeSendInformational } from './api.js';
import type { CardToolResult, InteractiveAdaptiveCard, InteractiveCardArgs, JsonValue, PolicySnapshot, TrustedTurnContext } from './contracts.js';
import { buildInteractiveCard, type InteractiveCapabilities } from './interactive-builder.js';
import { interactiveFailure, validateInteractiveArgs } from './interactive-schema.js';
import { normalizeLimits } from './limits.js';
import { renderInteractivePlain } from './plain.js';
import { canonicalJson } from './protocol.js';
import type { CardBinding, ExplicitCard } from './store.js';
import type { ExplicitOpContext, ExplicitOpHandler, ExplicitSendPort } from './tool-host.js';
import type { TzVersionReader } from './tz-support.js';

export type DegradationReason = 'profile_unavailable' | 'profile_incompatible';
export type InteractiveCapability =
  | { readonly kind: 'enabled'; readonly caps: InteractiveCapabilities; readonly snapshot: PolicySnapshot }
  | { readonly kind: 'degrade'; readonly reason: DegradationReason }
  | { readonly kind: 'denied' };

/** Mixed disabled/incompatible reasons cannot prove which capability was denied: fail closed. */
export function interactionDegradation(snapshot: PolicySnapshot): DegradationReason | undefined {
  if (snapshot.interaction.state === 'unavailable' && snapshot.reasons.length === 1 && snapshot.reasons[0] === 'profile_unavailable') return 'profile_unavailable';
  if (snapshot.interaction.state === 'disabled' && snapshot.reasons.length > 0 && snapshot.reasons.every(r => r === 'profile_incompatible' || r === 'template_incompatible') && snapshot.reasons.includes('profile_incompatible')) return 'profile_incompatible';
  return undefined;
}

export type InteractiveExplicitCard = Extract<ExplicitCard, { opcode: 'interactive'; informational?: false }> & {
  readonly authored: { readonly profile: 'octo/v2'; readonly card: InteractiveAdaptiveCard };
  readonly plain: string;
  readonly snapshot: PolicySnapshot;
};

function bindingOf(ctx: TrustedTurnContext): CardBinding | undefined {
  const e = ctx.routeEligibility, r = ctx.route;
  if (!e || e.obo !== false || e.docTask !== false || e.cron !== false || ctx.origin?.kind !== 'user') return undefined;
  const kinds: Record<number, string> = { 1: 'dm', 2: 'group', 5: 'topic' };
  if (!r || !r.channelId || kinds[r.channelType] !== e.kind || !ctx.requesterUid || !ctx.sessionKey || !ctx.turnGeneration) return undefined;
  if (r.channelType !== 1 && r.channelType !== 2 && r.channelType !== 5) return undefined;
  const topicScope = r.topicScope ?? null;
  if ((e.kind === 'topic') !== (topicScope !== null) || (topicScope !== null && topicScope !== r.channelId)) return undefined;
  return Object.freeze({ sessionKey: ctx.sessionKey, channelId: r.channelId, channelType: r.channelType, topicScope, generation: ctx.turnGeneration, resetEpoch: ctx.resetEpoch });
}
function digest(value: unknown): string { return createHash('sha256').update(canonicalJson(value as JsonValue)).digest('hex'); }
export function createExplicitInteractive(options: { readonly capabilities?: () => InteractiveCapability | Promise<InteractiveCapability>; readonly tzVersion?: TzVersionReader } = {}): ExplicitOpHandler<'interactive'> {
  return Object.freeze({
    op: 'interactive' as const,
    async handle(args: InteractiveCardArgs, c: ExplicitOpContext, send: ExplicitSendPort, signal: AbortSignal): Promise<CardToolResult> {
      const err = (code: 'unavailable' | 'invalid_route' | 'policy_denied', rule: string): CardToolResult => ({ status: 'error', error: interactiveFailure(code, '$', rule).error });
      if (signal.aborted) return err('unavailable', 'explicit_authority_closed');
      const binding = bindingOf(c.ctx);
      if (!binding) return err('invalid_route', 'route_ineligible');
      const schema = validateInteractiveArgs(args, { tzVersion: options.tzVersion });
      if (!schema.ok) return { status: 'error', error: schema.error };
      let capability: InteractiveCapability;
      try { capability = await (options.capabilities?.() ?? { kind: 'denied' }); }
      catch { capability = { kind: 'degrade', reason: 'profile_unavailable' }; }
      if (signal.aborted) return err('unavailable', 'explicit_authority_closed');
      if (capability.kind === 'denied') return err('policy_denied', 'interaction_policy');
      if (capability.kind === 'degrade') {
        const plain = renderInteractivePlain(schema.value, binding.channelType !== 1, true);
        try { serializeSendInformational({ route: binding, plain, clientMsgNo: '00000000-0000-0000-0000-000000000000' }); }
        catch { return { status: 'error', error: interactiveFailure('limit_exceeded', '$', 'wire_bytes').error }; }
        return send.reserveAndSend(Object.freeze({ opcode: 'interactive', informational: true, binding, bodyDigest: digest({ plain }), plain, reason: capability.reason }));
      }
      const built = buildInteractiveCard(schema.value, { caps: capability.caps, route: binding });
      if (!built.ok) return { status: 'error', error: built.error };
      const limits = { ...normalizeLimits(undefined).limits, ...capability.caps.limits };
      const card: InteractiveExplicitCard = Object.freeze({ opcode: 'interactive', binding, bodyDigest: digest({ ...built.authored, plain: built.plain }), profile: 'octo/v2',
        pinnedLimitsJson: JSON.stringify(limits), authored: built.authored, plain: built.plain, snapshot: capability.snapshot,
        contract: Object.freeze({ requesterUid: c.ctx.requesterUid, contractVersion: 1,
          authoredContractJson: canonicalJson({ inputs: schema.value.inputs ?? [], buttons: schema.value.buttons } as unknown as JsonValue),
          authoredDataHash: digest(schema.value.buttons.map(b => ({ id: b.id, data: b.data ?? {} }))) }) });
      return send.reserveAndSend(card);
    },
  });
}
export const EXPLICIT_INTERACTIVE = createExplicitInteractive();
