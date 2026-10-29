/** Serial, explicitly injected fake-event harness. Production has no source wiring. */
import { createHash } from 'node:crypto';
import { OctoApiError } from './api.js';
import type { CardResourceOwner, MonotonicClock, ShutdownFence } from './contracts.js';
import type { NormalizedOrigin } from './origin.js';
import { CardStore, CardStoreError, type AttemptStartInput, type FinalDisposition, type SettingsEventIdentity } from './store.js';
import { boundedId, canonicalEnvelope, eventKey, sameScope, validateTopology,
  type EventScope, type ProvenTopology, type TopologyProof } from './topology.js';

export interface FakeEvent {
  readonly binding: EventScope;
  readonly wireId: string;
  readonly position: string;
  readonly previous: string | null;
  readonly eventClass: string;
  readonly payload: unknown;
}

export interface FakeEventSource {
  readonly kind: 'fake';
  /** Strictly after the confirmed ACK. Reading must not consume events. */
  read(afterConfirmedAck: string | null, signal: AbortSignal): Promise<readonly FakeEvent[]>;
  /** Idempotent per-event ACK; no cumulative or numeric adapter coercion. */
  ack(event: FakeEvent, signal: AbortSignal): Promise<void>;
  /** Independent authenticated-source evidence, never a payload claim. */
  verifyOwned(event: FakeEvent): { readonly owned: boolean; readonly actorUid?: string };
}

export type FakeActionResult =
  | { readonly kind: 'final'; readonly disposition: Exclude<FinalDisposition, 'admitted' | 'dead_letter'> }
  | { readonly kind: 'retry' }
  | { readonly kind: 'hold' };
export type FakeActionHandler = (event: FakeEvent, signal: AbortSignal) => Promise<FakeActionResult>;

export interface FakeConsumerOptions {
  readonly store: CardStore;
  readonly binding: EventScope;
  readonly proof: () => TopologyProof | undefined;
  readonly verifyProof: (proof: TopologyProof) => boolean;
  readonly now: () => number;
  readonly source: FakeEventSource;
  /** Missing future WP12 wiring keeps even initial source reads off. */
  readonly handler: () => FakeActionHandler | undefined;
  readonly invalidate: () => void;
  /** Synchronous interaction fence, called before attempting durable halt. */
  readonly fence: () => void;
  readonly freshMember?: (event: FakeEvent, actorUid: string, signal: AbortSignal) => Promise<'member' | 'not_member' | 'unavailable'>;
  readonly checkPolicy?: (signal: AbortSignal) => Promise<'allowed' | 'denied' | 'unavailable'>;
  /** Trusted fixture witness must fence the prior incarnation before saying retired. */
  readonly startedOwner?: (identity: AttemptStartInput) => 'live' | 'retired' | 'unknown';
  /** Structural subset of the existing shared origin pacer; owns no timers. */
  readonly pacing?: { readonly pacer: {
    gate(origin: NormalizedOrigin): { readonly eligible: boolean };
    observe429(origin: NormalizedOrigin, retryAfterMs: number | undefined, receiptMono: number): void;
  }; readonly origin: NormalizedOrigin; readonly clock: MonotonicClock };
}

export type PumpResult = { readonly kind: 'off' | 'closed' | 'held' | 'processed'; readonly count?: number }
  | { readonly kind: 'halted'; readonly persisted: boolean };

export interface FakeEventConsumer extends CardResourceOwner {
  readonly scope: string | undefined;
  /** One finite fake-source batch. Concurrent callers join the same operation. */
  pump(): Promise<PumpResult>;
}

function object(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

function freezeJson(v: unknown): void {
  if (v !== null && typeof v === 'object') { Object.values(v).forEach(freezeJson); Object.freeze(v); }
}

export function createFakeEventConsumer(options: FakeConsumerOptions): FakeEventConsumer {
  const { store, source } = options;
  let topology: ProvenTopology | undefined;
  let stopped = false, fenced = false;
  let haltResult: PumpResult | undefined;
  let current: Promise<PumpResult> | undefined;
  const controller = new AbortController();
  const invalidated = new Set<string>();
  // Only this incarnation can prove that its pre-handler work settled safely.
  // A restart still needs the independent retired-owner witness for a started T0.
  let settledHold: { readonly eventId: string; readonly attemptNo: 1 | 2 | 3 } | undefined;
  const active = (): boolean => !stopped && !fenced && !store.retired && !controller.signal.aborted;
  const eligible = (): boolean => !options.pacing || options.pacing.pacer.gate(options.pacing.origin).eligible;
  const proofValid = (): boolean => {
    const proof = options.proof();
    const current = proof && validateTopology(options.binding, proof, options.verifyProof, options.now());
    return !!topology && options.now() < topology.expiresAt && !!current
      && current.scope === topology.scope && current.topology === topology.topology;
  };

  function halt(reason: string): PumpResult {
    if (haltResult) return haltResult;
    fenced = true;
    try { options.fence(); } catch { /* authority stays fenced */ }
    let persisted = false;
    if (!stopped && !store.retired && topology) {
      try { persisted = store.haltCursor(topology.scope, reason)?.haltedReason !== null
        && store.readCursor(topology.scope)?.haltedReason != null; } catch { /* retain failure, never claim durability */ }
    }
    haltResult = { kind: 'halted', persisted };
    return haltResult;
  }

  function observe(error: unknown): void {
    if (error instanceof OctoApiError && error.status === 429 && options.pacing) {
      const { pacer, origin, clock } = options.pacing;
      pacer.observe429(origin, error.retryAfterMs, clock.nowMono());
    }
  }

  async function ack(event: FakeEvent): Promise<PumpResult | undefined> {
    if (!active() || !topology || options.now() >= topology.expiresAt) return { kind: 'closed' };
    if (!eligible()) return { kind: 'held' };
    try {
      await source.ack(event, controller.signal);
      if (!active()) return { kind: 'closed' };
      if (!store.recordAck(topology.scope, event.position)) return { kind: 'held' };
      return undefined;
    } catch (error) { observe(error); return { kind: 'held' }; }
  }

  async function handle(event: FakeEvent): Promise<PumpResult | undefined> {
    if (!active() || !topology || options.now() >= topology.expiresAt) return { kind: 'held' };
    if (!eligible()) return { kind: 'held' };
    if (!sameScope(event.binding, topology.binding) || !boundedId(event.wireId) || !boundedId(event.position)
      || (event.previous !== null && (!boundedId(event.previous) || event.previous === event.position))) return halt('scope_or_position');
    let authenticated: ReturnType<FakeEventSource['verifyOwned']>;
    try { authenticated = source.verifyOwned(event); } catch { return halt('ownership_unproven'); }
    if (authenticated?.owned !== true) return halt('ownership_unproven');
    const settings = event.eventClass === 'bot_setting_updated';
    if (!settings && event.eventClass !== 'card_action' && event.eventClass !== 'card_control') return halt('non_owned_class');
    const body = object(event.payload);
    if (settings && body?.scope !== 'bot_setting') return halt('non_owned_settings');
    const eventId = eventKey(topology.scope, event.wireId);
    let digest: string;
    try { digest = createHash('sha256').update(canonicalEnvelope({ event, actorUid: authenticated.actorUid ?? null })).digest('hex'); }
    catch { return halt('invalid_encoding'); }
    const session = !settings && boundedId(body?.sessionId) ? store.getSession(body.sessionId) : null;
    const common = { eventId, scope: topology.scope, eventClass: event.eventClass,
      positionRef: event.position, previousPositionRef: event.previous, envelopeDigest: digest };
    const identity: AttemptStartInput | SettingsEventIdentity = settings
      ? { ...common, eventClass: 'bot_setting_updated', settingsScope: 'bot_setting' }
      // Tagged JSON preserves structural absence without inventing a message authority.
      : { ...common, sessionId: session?.sessionId ?? null, messageId: canonicalEnvelope(boundedId(body?.messageId) ? body.messageId : null) };
    const replay = store.getEventReplay(eventId);
    if (replay.kind === 'inconsistent') return halt(replay.code);
    if (replay.kind === 'retained' && canonicalEnvelope(replay.identity) !== canonicalEnvelope(identity)) return halt('replay_identity');
    const cursor = store.readCursor(topology.scope);
    if (!cursor || cursor.haltedReason !== null) return halt('cursor_unavailable');
    if (replay.kind === 'retained' && replay.final) {
      if (cursor.cursor !== cursor.ackedThrough && cursor.cursor !== event.position) return halt('pending_ack_missing');
      if (settings && !invalidated.has(eventId)) { options.invalidate(); invalidated.add(eventId); }
      if (cursor.cursor === cursor.ackedThrough) return undefined;
      return ack(event);
    }
    if (cursor.cursor !== cursor.ackedThrough) return halt('pending_ack_missing');
    if (event.previous !== cursor.cursor) return halt('predecessor_conflict');
    const advance = { scope: topology.scope, expectedPrevious: event.previous, next: event.position };
    if (settings) {
      options.invalidate(); invalidated.add(eventId);
      const result = store.recordEventInvalidation({ ...identity as SettingsEventIdentity, cursor: advance });
      if (result.kind !== 'recorded' && result.kind !== 'already_final') return halt('final_commit_conflict');
      return ack(event);
    }
    const handler = options.handler();
    if (!handler) return { kind: 'held' };
    const action = identity as AttemptStartInput;
    // Structural/binding rejects are definitive only after independent ownership.
    let rejection: Exclude<FinalDisposition, 'admitted' | 'dead_letter'> | undefined;
    if (!body || !boundedId(body.messageId) || !boundedId(body.sessionId)) rejection = 'invalid';
    else if (!session) rejection = 'unknown';
    else {
      const message = store.getMessage(session.cardId);
      if (!message || (message.messageId !== null && message.messageId !== body.messageId)) rejection = 'invalid';
      else if (body.channelId !== session.channelId || body.channelType !== session.channelType
        || body.topicScope !== session.topicScope) rejection = 'unauthorized';
      else if (!boundedId(authenticated.actorUid) || authenticated.actorUid !== body.requesterUid
        || authenticated.actorUid !== session.requesterUid) rejection = 'unauthorized';
      else if (message.messageId === null) {
        if ((message.state === 'sending' || message.state === 'ambiguous')
          && (session.status === 'sending' || session.status === 'ambiguous')) {
          // Retain the callback identity without using it as T-bind authority.
          if (store.recordSendWait(action).kind !== 'send_wait') return halt('identity_commit_conflict');
          return { kind: 'held' };
        }
        rejection = 'invalid';
      }
      else if (session.status === 'admitted' || session.status === 'ambiguous' || store.getAdmissionForSession(session.sessionId)) return { kind: 'held' };
    }
    if (rejection) {
      const retained = store.recordSendWait(action);
      if (retained.kind !== 'send_wait' && !(replay.kind === 'retained' && replay.attempt)) return halt('identity_commit_conflict');
      const final = store.recordDisposition({ ...action, disposition: rejection, cursor: advance });
      if (final.kind !== 'recorded' && final.kind !== 'already_final') return halt('final_commit_conflict');
      return ack(event);
    }
    const localAttempt = settledHold?.eventId === eventId ? settledHold.attemptNo : undefined;
    const resume = replay.kind === 'retained' && replay.attempt?.phase === 'started'
      && localAttempt === replay.attempt.number;
    if (replay.kind === 'retained' && replay.attempt?.phase === 'started' && !resume) {
      if (options.startedOwner?.(action) !== 'retired') return { kind: 'held' };
      const recovered = store.recordAttemptFailure({ eventId, reasonCode: 'interrupted', cursor: advance });
      if (recovered.kind === 'dead_letter') return ack(event);
      if (recovered.kind !== 'retry_wait') return halt('interruption_conflict');
      return { kind: 'held' };
    }
    settledHold = undefined;
    const start = resume ? { kind: 'started' as const, attemptNo: localAttempt! } : store.recordAttemptStart(action);
    if (start.kind === 'not_eligible' || start.kind === 'in_progress') return { kind: 'held' };
    if (start.kind !== 'started') return halt('attempt_conflict');
    let result: FakeActionResult;
    let handlerStarted = false;
    try {
      if (session!.channelType !== 1) {
        const member = await options.freshMember?.(event, authenticated.actorUid!, controller.signal);
        if (!active()) return { kind: 'closed' };
        if (member === 'not_member') result = { kind: 'final', disposition: 'unauthorized' };
        else if (member !== 'member') result = { kind: 'retry' };
        else result = await policyAndHandler();
      } else result = await policyAndHandler();
    } catch (error) { observe(error); result = { kind: 'retry' }; }
    if (!active()) return { kind: 'closed' };
    if (result.kind === 'hold' || !proofValid()) {
      // Save the settled witness before EVERY pre-handler wait, including proof
      // expiry/revocation after an awaited check. Renewal never resets T0.
      // A handler's own hold may hide ambiguous work and cannot grant a rerun.
      if (!handlerStarted) settledHold = { eventId, attemptNo: start.attemptNo };
      return { kind: 'held' };
    }
    if (result.kind === 'retry') {
      const failure = store.recordAttemptFailure({ eventId, reasonCode: 'pre_admission', cursor: advance });
      if (failure.kind === 'retry_wait') return { kind: 'held' };
      if (failure.kind !== 'dead_letter') return halt('failure_commit_conflict');
    } else {
      const final = store.recordDisposition({ ...action, disposition: result.disposition, cursor: advance, attempts: start.attemptNo });
      if (final.kind !== 'recorded' && final.kind !== 'already_final') return halt('final_commit_conflict');
    }
    return ack(event);

    async function policyAndHandler(): Promise<FakeActionResult> {
      if (!active() || !eligible() || !proofValid()) return { kind: 'hold' };
      const policy = await options.checkPolicy?.(controller.signal);
      if (!active() || !proofValid()) return { kind: 'hold' };
      if (policy === 'denied') return { kind: 'final', disposition: 'unauthorized' };
      if (policy !== 'allowed') return { kind: 'retry' };
      if (session!.expiresAt <= options.now()) return { kind: 'final', disposition: 'expired' };
      if (!options.handler() || !eligible() || options.now() >= topology!.expiresAt) return { kind: 'hold' };
      handlerStarted = true;
      return handler!(event, controller.signal);
    }
  }

  async function run(): Promise<PumpResult> {
    if (haltResult) return haltResult;
    if (!active()) return { kind: 'closed' };
    try {
      const proof = options.proof();
      const next = proof && validateTopology(options.binding, proof, options.verifyProof, options.now());
      if (!next || source.kind !== 'fake' || !options.handler()) return { kind: 'off' };
      if (topology && topology.scope !== next.scope) return halt('proof_scope_changed');
      topology = next;
      const cursor = store.initCursor(topology.scope, topology.topology);
      if (cursor.haltedReason !== null || cursor.topology !== topology.topology) return halt('durable_halt');
      if (!eligible()) return { kind: 'held' };
      let events: readonly FakeEvent[];
      try { events = await source.read(cursor.ackedThrough, controller.signal); }
      catch (error) { observe(error); return { kind: 'held' }; }
      if (!active()) return { kind: 'closed' };
      if (!Array.isArray(events) || events.length > 1000) return halt('invalid_batch');
      if (!events.length && cursor.cursor !== cursor.ackedThrough) return halt('pending_ack_missing');
      // Snapshot before any asynchronous handler; no caller can rewrite later batch entries.
      let owned: readonly FakeEvent[];
      try { owned = JSON.parse(canonicalEnvelope(events)) as FakeEvent[]; freezeJson(owned); }
      catch { return halt('invalid_encoding'); }
      let count = 0;
      for (const event of owned) {
        const result = await handle(event);
        if (result) return result;
        count++;
      }
      return { kind: 'processed', count };
    } catch (error) {
      return active() ? halt(error instanceof CardStoreError && error.code === 'scope_conflict'
        ? 'scope_reconciliation_required' : 'storage_or_invalidation') : { kind: 'closed' };
    }
  }

  return Object.freeze({
    kind: 'event_consumer' as const,
    get scope() { return topology?.scope; },
    pump(): Promise<PumpResult> {
      if (!current) {
        const p = run(); current = p;
        void p.finally(() => { if (current === p) current = undefined; });
      }
      return current;
    },
    close(): void { stopped = true; controller.abort(); },
    async drain(fence: ShutdownFence) {
      const pending = current;
      if (!pending) return { settled: 0, aborted: 0, unresolved: 0 };
      let onAbort!: () => void;
      const aborted = new Promise<'unresolved'>((resolve) => { onAbort = () => resolve('unresolved');
        if (fence.signal.aborted) onAbort(); else fence.signal.addEventListener('abort', onAbort, { once: true }); });
      const outcome = await Promise.race([pending.then(() => 'settled' as const), aborted]);
      fence.signal.removeEventListener('abort', onAbort);
      return outcome === 'settled' ? { settled: 1, aborted: 0, unresolved: 0 } : { settled: 0, aborted: 0, unresolved: 1 };
    },
  });
}
