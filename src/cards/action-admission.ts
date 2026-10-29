/** Requester-only WP12 admission. T0/retry/ACK remain owned by the event consumer. */
import { createHash } from 'node:crypto';
import type { ButtonSpec, ContinuationPort, ContinuationTurn, InputSpec, Limits } from './contracts.js';
import { createContinuation, getContinuation, prepareContinuation } from './continuation.js';
import type { FakeActionHandler, FakeActionResult, FakeEvent, FakeEventSource, FakeStatusObserver } from './event-consumer.js';
import { createInputNormalizer } from './input-normalize.js';
import { validateInteractiveArgs } from './interactive-schema.js';
import { canonicalJson } from './protocol.js';
import type { CardSessionRecord, CardStore } from './store.js';
import { boundedId, canonicalEnvelope, eventKey, sameScope, type EventScope } from './topology.js';

export interface ContinuationContext {
  readonly sessionKey: string; readonly channelId: string; readonly channelType: number;
  readonly topicScope: string | null; readonly requesterUid: string; readonly resetEpoch: number;
  readonly obo: false; readonly docTask: false;
}
export type ActionStatus = 'Please check your response.' | 'Processing' | 'Retrying' | 'Unable to start. Please try again.'
  | 'Completed' | 'Failed' | 'Interrupted; outcome needs review' | 'Expired';
export interface ActionStatusEdit {
  readonly signal: AbortSignal;
  /** Recheck immediately before each write and after its acknowledgement. */
  readonly current: () => boolean;
  readonly session: CardSessionRecord; readonly messageId: string; readonly status: ActionStatus;
  readonly contract: { readonly inputs: readonly InputSpec[]; readonly buttons: readonly ButtonSpec[] };
  readonly controls: boolean;
}
export interface ActionAdmissionOptions {
  readonly store: CardStore; readonly binding: EventScope; readonly now: () => number;
  readonly scope: () => string | undefined;
  readonly authenticate: FakeEventSource['verifyOwned'];
  /** Independent topology/ownership evidence, checked at every asynchronous boundary. */
  readonly authority: (event: FakeEvent) => boolean;
  readonly context: (session: CardSessionRecord) => ContinuationContext | undefined;
  readonly freshMember: (event: FakeEvent, actorUid: string, signal: AbortSignal) => Promise<'member' | 'not_member' | 'unavailable'>;
  readonly policy: (signal: AbortSignal) => Promise<'allowed' | 'denied' | 'unavailable'>;
  readonly currentPolicy: () => boolean;
  readonly limits?: () => Limits | undefined;
  /** Preflight, T2 and dispatch share the ordinary router's session lock. */
  readonly withSession: <T>(turn: ContinuationTurn, fn: (port: ContinuationPort) => Promise<T>) => Promise<T>;
  readonly edit?: (edit: ActionStatusEdit) => Promise<void>;
}
const final = (disposition: Extract<FakeActionResult, { kind: 'final' }>['disposition']): FakeActionResult => ({ kind: 'final', disposition });
const hold = (): FakeActionResult => ({ kind: 'hold' });
const retry = (): FakeActionResult => ({ kind: 'retry' });
const hash = (value: unknown): string => createHash('sha256').update(canonicalEnvelope(value)).digest('hex');

export function createActionAdmission(options: ActionAdmissionOptions): FakeActionHandler & { readonly statusObserver: FakeStatusObserver } {
  async function run(incoming: FakeEvent, signal: AbortSignal,
    notice?: { readonly status: 'Retrying' | 'Failed'; readonly current: () => boolean }): Promise<FakeActionResult> {
    let event: FakeEvent;
    try { event = JSON.parse(canonicalEnvelope(incoming)) as FakeEvent; } catch { return hold(); }
    const source = (): boolean => {
      try { return !signal.aborted && !options.store.retired && (!notice || notice.current()) && sameScope(event.binding, options.binding)
        && options.authority(event) && options.authenticate(event).owned === true; } catch { return false; }
    };
    if (!source()) return hold();
    if (!boundedId(event.wireId) || !boundedId(event.position) || (event.previous !== null && !boundedId(event.previous))) return final('poison');
    if (event.eventClass === 'card_control') return final('unsupported_control');
    if (event.eventClass !== 'card_action') return final('unknown');
    const body = event.payload as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || !boundedId(body.messageId)) return final('invalid');
    const session = options.store.findSessionByMessageId(body.messageId);
    if (!session) return final('unknown');
    if (body.sessionId !== session.sessionId) return final('unauthorized');
    if (body.channelId !== session.channelId || body.channelType !== session.channelType || body.topicScope !== session.topicScope) return final('unauthorized');
    const actor = options.authenticate(event).actorUid;
    if (!boundedId(actor) || actor !== session.requesterUid || body.requesterUid !== actor) return final('unauthorized');
    const contextMatches = (): boolean => {
      const ctx = options.context(session);
      return !!ctx && ctx.obo === false && ctx.docTask === false && ctx.sessionKey === session.sessionKey
        && ctx.channelId === session.channelId && ctx.channelType === session.channelType && ctx.topicScope === session.topicScope
        && ctx.requesterUid === actor && ctx.resetEpoch === session.resetEpoch
        && [1, 2, 5].includes(session.channelType)
        && (session.channelType === 5 ? session.topicScope === session.channelId : session.topicScope === null);
    };
    const current = (): boolean => {
      try { return source() && options.authenticate(event).actorUid === actor && contextMatches(); } catch { return false; }
    };
    if (!current()) return final('unauthorized');
    const authorized = async (): Promise<'allowed' | 'denied' | 'unavailable' | 'hold'> => {
      if (!current()) return 'hold';
      if (session.channelType !== 1) {
        let member: Awaited<ReturnType<ActionAdmissionOptions['freshMember']>>;
        try { member = await options.freshMember(event, actor, signal); } catch { member = 'unavailable'; }
        if (!current()) return 'hold';
        if (member === 'not_member') return 'denied';
        if (member !== 'member') return 'unavailable';
      }
      let policy: Awaited<ReturnType<ActionAdmissionOptions['policy']>>;
      try { policy = await options.policy(signal); } catch { policy = 'unavailable'; }
      if (!current()) return 'hold';
      return policy === 'allowed' && !options.currentPolicy() ? 'denied' : policy;
    };
    const permission = await authorized();
    if (permission === 'hold') return hold();
    if (permission === 'denied') return final('unauthorized');
    if (permission !== 'allowed') return retry();
    if (!notice && session.expiresAt <= options.now()) return final('expired');
    if (!notice && (options.store.getAdmissionForSession(session.sessionId) || !['pending', 'retry_wait'].includes(session.status))) return final('duplicate');
    let contract: { inputs: readonly InputSpec[]; buttons: readonly ButtonSpec[] };
    try {
      if (session.contractVersion !== 1) return hold();
      const parsed = JSON.parse(session.authoredContractJson);
      if (Object.keys(parsed).some(k => k !== 'inputs' && k !== 'buttons')) return hold();
      const validated = validateInteractiveArgs({ title: 'Response', ...parsed });
      if (!validated.ok) return hold();
      contract = { inputs: validated.value.inputs ?? [], buttons: validated.value.buttons };
      const buttonsHash = createHash('sha256').update(canonicalJson(contract.buttons.map(b => ({ id: b.id, data: b.data ?? {} })))).digest('hex');
      if (buttonsHash !== session.authoredDataHash) return hold();
    } catch { return hold(); }
    const show = async (status: ActionStatus, controls: boolean): Promise<void> => {
      const frameCurrent = (): boolean => {
        if (!current() || !options.currentPolicy()) return false;
        const latest = options.store.getSession(session.sessionId);
        const admission = options.store.getAdmissionForSession(session.sessionId);
        if (!latest) return false;
        if (controls) return !admission && ['pending', 'retry_wait'].includes(latest.status) && latest.expiresAt > options.now();
        if (status === 'Processing') return admission?.state === 'admitted';
        if (status === 'Completed') return admission?.state === 'completed';
        if (status === 'Failed') return latest.status === 'dead_letter' || admission?.state === 'failed';
        if (status === 'Interrupted; outcome needs review') return admission?.state === 'ambiguous';
        return !admission && latest.status === 'retry_wait';
      };
      try { if (await authorized() === 'allowed' && frameCurrent()) await options.edit?.({ session, messageId: body.messageId as string, status, controls, contract, signal, current: frameCurrent }); }
      catch { /* edits never release or replay an admission */ }
    };
    if (notice) { await show(notice.status, false); return hold(); }
    const button = contract.buttons.find(b => b.id === body.actionId);
    const normalized = createInputNormalizer({ limits: options.limits?.() })(contract.inputs, Object.hasOwn(body, 'inputs') ? body.inputs : {});
    if (Object.keys(body).some(k => !['sessionId', 'messageId', 'channelId', 'channelType', 'topicScope', 'requesterUid', 'actionId', 'data', 'inputs'].includes(k))
      || !button || canonicalEnvelope(Object.hasOwn(body, 'data') ? body.data : {}) !== canonicalEnvelope(button.data ?? {}) || !normalized.ok) {
      await show('Please check your response.', true); return final('invalid');
    }
    let prepared: ReturnType<typeof prepareContinuation>;
    prepared = prepareContinuation({ session, button, inputs: normalized.value, specs: contract.inputs,
      authorize: async () => await authorized() === 'allowed', current: () => current() && options.currentPolicy(),
      settle: outcome => {
        const admission = options.store.getAdmissionForSession(session.sessionId);
        if (!admission || admission.admissionId !== prepared.turn.admissionId
          || admission.continuationGeneration !== getContinuation(prepared.turn)?.generation) return;
        if (outcome === 'ambiguous') options.store.markAdmissionAmbiguous(admission.admissionId);
        else options.store.settleAdmission(admission.admissionId, outcome);
      } });
    try { return await options.withSession(prepared.turn, async port => {
      const permission = await authorized();
      if (permission !== 'allowed') return permission === 'hold' ? hold() : permission === 'denied' ? final('unauthorized') : retry();
      const continuation = createContinuation(port);
      const preflight = continuation.preflightContinuation(prepared.turn);
      if (!preflight.accepted) { await show('Unable to start. Please try again.', true); return final('rejected'); }
      if (!current()) return hold();
      if (!options.currentPolicy()) return final('unauthorized');
      const detail = getContinuation(prepared.turn)!;
      const scope = options.scope();
      if (!scope) return hold();
      const result = options.store.admitOnce({ eventId: eventKey(scope, event.wireId),
        scope, eventClass: event.eventClass, sessionId: session.sessionId,
        continuationGeneration: detail.generation, submittedHash: hash({ actionId: button.id, inputs: normalized.value }),
        currentResetEpoch: session.resetEpoch, cursor: { scope, expectedPrevious: event.previous, next: event.position } });
      if (result.kind !== 'admitted') return result.kind === 'duplicate' ? final('duplicate') : hold();
      prepared.bindAdmission(result.admissionId);
      try {
        if (await detail.authorize() && detail.current()) {
          await show('Processing', false);
          if (await detail.authorize() && detail.current()) await continuation.dispatchContinuation(prepared.turn, preflight.reservation);
        }
      } catch { /* uncertainty after T2 never becomes a retry */ }
      finally { detail.settle('ambiguous'); }
      const state = options.store.getAdmissionForSession(session.sessionId)?.state;
      await show(state === 'completed' ? 'Completed' : state === 'failed' ? 'Failed' : 'Interrupted; outcome needs review', false);
      // The consumer sees the existing admitted final record and only ACKs it.
      return final('duplicate');
    }); } catch {
      const a = options.store.getAdmissionForSession(session.sessionId);
      if (a) {
        if (a.continuationGeneration === getContinuation(prepared.turn)?.generation) options.store.markAdmissionAmbiguous(a.admissionId);
        return final('duplicate');
      }
      return retry();
    }
  }
  const handler: FakeActionHandler = (event, signal) => run(event, signal);
  return Object.assign(handler, { statusObserver: async (event, status, signal, current) => {
    await run(event, signal, { status, current });
  } } satisfies { statusObserver: FakeStatusObserver });
}
