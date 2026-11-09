import { randomBytes } from 'node:crypto';
import type { BotMessage } from '../octo/types.js';
import type { ReceivedDelivery, IngressReservation, ReserveBeforeAck } from './ingress-reservation.js';
import { ReplayJournal, type ReplayIdentity } from './replay-journal.js';
import { canonicalControl, object, PermissionRefusal, permissionRefusalText, type ControlMethod, type RefusalRecord } from './control-client.js';
import { bindContextManifest } from './context-manifest.js';
import { TurnLease } from './turn-lease.js';

export interface PermissionKey { origin: string; bot_uid: string; space_id: string }
export interface NativeHeader {
  header_version: 1;
  header_reference: string;
  message_id: string;
  source: { kind: 'dm' | 'group' | 'thread'; id: string };
  parent_group: string | null;
  space_id: string;
  author_uid: string;
  author_kind: 'human' | 'user_bot' | 'app_bot' | 'system';
  recipient_bot_uid: string;
  native_message_version: string;
  payload_sha256: string;
  delivery: { stream_id: string; stream_incarnation: string; sequence: string };
}

export interface NativeIngress {
  readonly deliveryReference: string;
  readonly header: Readonly<NativeHeader>;
}

export interface EndpointBinding {
  readonly ingressId: string;
  readonly capsuleId: string;
  readonly turnId: string;
  readonly contextId: string;
  readonly generation: string;
  readonly header: Readonly<NativeHeader>;
}

/** Private host composition, never model-supplied metadata or a policy verdict. */
export interface EndpointHostPorts {
  readonly key: Readonly<PermissionKey>;
  readonly recipientId: string;
  relayTransport: 'http' | 'stdio';
  readonly journal: ReplayJournal;
  readonly authoritySignal?: AbortSignal;
  /** Native producer must inspect without content-first lookup and compare the
   * original delivery. No implementation may promote wire observations to F. */
  inspect(delivery: ReceivedDelivery): Promise<NativeIngress>;
  control: { call(method: ControlMethod, payload: Record<string, unknown>): Promise<Record<string, unknown>> };
  candidate(message: BotMessage): Promise<boolean>;
  /** Metadata-first originals + their permitted exact bodies, after admission.
   * This producer owns its disclosure/read boundaries and optional import limits. */
  prepareInput(binding: Readonly<EndpointBinding>, signal: AbortSignal): Promise<{
    input: string;
    originals: readonly Readonly<NativeHeader>[];
  }>;
  /** Owns actual model input/start and the generation-isolated worker/relay;
   * cannot implement this as a cached allow followed by an unchecked launch. */
  runWorker(binding: Readonly<EndpointBinding>, input: string, relay: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<string>;
  /** Owns the fresh native-publication physical sink. No returned allow ticket. */
  publish(binding: Readonly<EndpointBinding>, text: string, signal: AbortSignal): Promise<void>;
  /** Independently prove the original native route; at most one <=2s attempt.
   * Missing/unsafe reply authority suppresses delivery, never chooses a new route. */
  refuse(ingress: Readonly<NativeIngress>, record: Readonly<RefusalRecord>, text: string, signal: AbortSignal): Promise<void>;
  /** Join/quarantine all workers and queues before releasing generation state. */
  stop(): Promise<void>;
}

export interface PermissionEndpoint {
  readonly reserveBeforeAck: ReserveBeforeAck;
  handle(message: BotMessage): Promise<void>;
  stop(): Promise<void>;
}

function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) throw new Error('Permission identity unavailable');
  return value;
}

function nativeHeader(value: unknown): Readonly<NativeHeader> {
  const h = object(value, ['header_version', 'header_reference', 'message_id', 'source', 'parent_group', 'space_id',
    'author_uid', 'author_kind', 'recipient_bot_uid', 'native_message_version', 'payload_sha256', 'delivery']);
  const source = object(h.source, ['kind', 'id']);
  const delivery = object(h.delivery, ['stream_id', 'stream_incarnation', 'sequence']);
  const text = (v: unknown, scalars: number, bytes: number) => typeof v === 'string' && v.length > 0
    && [...v].length <= scalars && Buffer.byteLength(v) <= bytes && Buffer.from(v).toString() === v;
  const token = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(v);
  if (h.header_version !== 1 || !token(h.header_reference) || !token(h.native_message_version)
    || typeof h.message_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(h.message_id) || BigInt(h.message_id) > 9223372036854775807n
    || !text(h.space_id, 40, 160) || !text(h.author_uid, 40, 160) || !text(h.recipient_bot_uid, 40, 160)
    || !['human', 'user_bot', 'app_bot', 'system'].includes(String(h.author_kind))
    || typeof h.payload_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(h.payload_sha256)
    || !['dm', 'group', 'thread'].includes(String(source.kind))
    || !text(source.id, source.kind === 'dm' ? 100 : source.kind === 'group' ? 40 : 256,
      source.kind === 'dm' ? 400 : source.kind === 'group' ? 160 : 256)
    || (source.kind === 'thread' ? !text(h.parent_group, 40, 160) : h.parent_group !== null)
    || typeof delivery.stream_id !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(delivery.stream_id)
    || typeof delivery.stream_incarnation !== 'string' || !/^[0-9a-f]{32}$/.test(delivery.stream_incarnation)
    || typeof delivery.sequence !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(delivery.sequence)
    || BigInt(delivery.sequence) > 18446744073709551615n) throw new Error('Native Header unavailable');
  Object.freeze(source); Object.freeze(delivery);
  return Object.freeze(h) as unknown as Readonly<NativeHeader>;
}

/**
 * The actual gateway-owned receive -> durable reservation -> admission ->
 * disclosure -> manifest -> worker -> publication pipeline. All ports are
 * trusted host producers; none is accepted through MCP arguments/config claims.
 * The missing native/control/sink production adapters remain explicit ports.
 */
export class EndpointPermissionHost implements PermissionEndpoint {
  private readonly received = new WeakMap<BotMessage, Readonly<NativeIngress>>();
  private readonly active = new Set<Promise<void>>();
  private readonly receives = new Set<Promise<IngressReservation>>();
  private readonly controllers = new Set<AbortController>();
  private stopping = false;
  private readonly key: Readonly<PermissionKey>;
  private readonly recipientId: string;
  readonly reserveBeforeAck: ReserveBeforeAck;

  constructor(private readonly ports: EndpointHostPorts) {
    this.key = Object.freeze({ ...ports.key }); this.recipientId = ports.recipientId;
    this.reserveBeforeAck = delivery => {
      const task = this.reserve(delivery);
      this.receives.add(task);
      void task.then(() => this.receives.delete(task), () => this.receives.delete(task));
      return task;
    };
  }

  private async reserve(delivery: ReceivedDelivery): Promise<IngressReservation> {
    if (this.stopping || this.ports.authoritySignal?.aborted || delivery.recipientUid !== this.key.bot_uid) return { disposition: 'unavailable' };
    try {
      const inspected = await this.ports.inspect(delivery);
      const cloned = structuredClone(inspected);
      const ingress = Object.freeze({ deliveryReference: cloned.deliveryReference, header: nativeHeader(cloned.header) });
      const h = ingress.header;
      // These comparisons consume native evidence; they do not create it.
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(ingress.deliveryReference) || h.header_version !== 1
        || h.message_id !== delivery.message.message_id || h.author_uid !== delivery.message.from_uid
        || h.recipient_bot_uid !== delivery.recipientUid || h.space_id !== this.key.space_id
        || h.payload_sha256 !== delivery.payloadSha256 || h.source.id !== delivery.message.channel_id
        || ({ dm: 1, group: 2, thread: 5 })[h.source.kind] !== delivery.message.channel_type) return { disposition: 'unavailable' };
      const identity: ReplayIdentity = { origin: this.key.origin, recipientBotUid: h.recipient_bot_uid,
        streamId: h.delivery.stream_id, streamIncarnation: h.delivery.stream_incarnation, sequence: h.delivery.sequence,
        messageId: h.message_id, messageVersion: h.native_message_version, payloadSha256: h.payload_sha256 };
      if (this.stopping || this.ports.authoritySignal?.aborted) return { disposition: 'unavailable' };
      const reservation = this.ports.journal.reserve(identity);
      if (reservation.disposition === 'reserved') this.received.set(delivery.message, ingress);
      return reservation;
    } catch { return { disposition: 'unavailable' }; }
  }

  handle(message: BotMessage): Promise<void> {
    const ingress = this.received.get(message);
    this.received.delete(message); // A second callback cannot open a second turn.
    if (this.stopping || !ingress) return Promise.resolve();
    const task = this.process(message, ingress);
    this.active.add(task);
    void task.then(() => this.active.delete(task), () => this.active.delete(task));
    return task;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.active]);
    await Promise.allSettled([...this.receives]);
    await this.ports.stop();
  }

  private async process(message: BotMessage, ingress: Readonly<NativeIngress>): Promise<void> {
    const controller = new AbortController();
    const lost = () => controller.abort();
    this.ports.authoritySignal?.addEventListener('abort', lost, { once: true });
    if (this.ports.authoritySignal?.aborted) lost();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    let binding: Readonly<EndpointBinding> | undefined;
    let lease: TurnLease | undefined;
    let handled = false;
    let workerStarted = false;
    let workerFailed = false;
    const relayTransport = this.ports.relayTransport;
    try {
      if (relayTransport !== 'http' && relayTransport !== 'stdio') throw new Error('Relay transport unavailable');
      controller.signal.throwIfAborted();
      // Trigger/config discovery may run here; it supplies no invocation grant.
      if (!await this.ports.candidate(message)) return;
      controller.signal.throwIfAborted();
      const registered = object(await this.ports.control.call('register_ingress', {
        key: this.key, delivery_reference: ingress.deliveryReference,
        stream: ingress.header.delivery, payload_sha256: ingress.header.payload_sha256,
      }), ['ingress_id']);
      const contextId = randomBytes(16).toString('hex');
      const admitted = object(await this.ports.control.call('admit', {
        ingress_id: hex(registered.ingress_id), proposed_context_id: contextId,
      }), ['capsule_id', 'turn_id', 'generation']);
      binding = Object.freeze({ ingressId: hex(registered.ingress_id), capsuleId: hex(admitted.capsule_id), turnId: hex(admitted.turn_id),
        contextId, generation: hex(admitted.generation), header: ingress.header });
      lease = new TurnLease(this.ports.control, binding, controller);
      controller.signal.throwIfAborted();
      // Unknown legacy provenance is never resumed. This path creates a clean
      // generation; existing ContextProvenance supports later proven reuse.
      const prepared = await this.ports.prepareInput(binding, controller.signal);
      controller.signal.throwIfAborted();
      const originals = new Map<string, Readonly<NativeHeader>>();
      for (const supplied of [ingress.header, ...prepared.originals]) {
        const header = nativeHeader(structuredClone(supplied));
        if (header.recipient_bot_uid !== this.key.bot_uid || header.space_id !== this.key.space_id) {
          throw new Error('Contributor binding unavailable');
        }
        const exact = canonicalControl(header);
        originals.set(exact, header);
      }
      const manifest = { context_id: contextId, context_generation: binding.generation,
        originals: [...originals.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, header]) => header) };
      // bind_context checks the complete union against current facts/P, after
      // the disclosed input read and before model insertion. It returns no grant.
      await bindContextManifest(this.ports.control, binding.capsuleId, manifest, controller.signal);
      lease.assertCurrent();
      const relay = await this.ports.control.call('open_relay', { capsule_id: binding.capsuleId,
        recipient_id: this.recipientId, transport: relayTransport, relay_nonce: randomBytes(16).toString('hex') });
      controller.signal.throwIfAborted();
      workerStarted = true;
      const text = await this.ports.runWorker(binding, prepared.input, Object.freeze(relay), controller.signal);
      lease.assertCurrent();
      await this.ports.publish(binding, text, controller.signal);
    } catch (error) {
      // Renewal denial aborts the owned worker first. Preserve that authentic
      // typed verdict rather than turning the resulting AbortError into a retry.
      if (controller.signal.reason instanceof PermissionRefusal) error = controller.signal.reason;
      // An ordinary worker/publication failure may follow real effects. It is
      // not a permission verdict and must leave the ingress outcome uncertain.
      if (workerStarted && !(error instanceof PermissionRefusal)) { workerFailed = true; throw error; }
      if ((!controller.signal.aborted || error instanceof PermissionRefusal) && !handled) {
        handled = true; // Consume before the one original-route delivery attempt.
        const record: Readonly<RefusalRecord> = error instanceof PermissionRefusal ? error.record
          : Object.freeze({ version: 1, category: 'policy_unavailable', correlation: randomBytes(16).toString('hex') });
        try { await this.ports.refuse(ingress, record, permissionRefusalText(record), AbortSignal.timeout(2000)); } catch { /* suppression; no fallback/generic duplicate */ }
      }
    } finally {
      await lease?.stop();
      this.ports.authoritySignal?.removeEventListener('abort', lost);
      clearTimeout(timer); this.controllers.delete(controller);
      if (binding) {
        try { await this.ports.control.call('close', { capsule_id: binding.capsuleId,
          reason: handled ? 'refused' : controller.signal.aborted ? 'cancelled' : workerFailed ? 'worker_failed' : 'completed' }); } catch { /* revoked host handles never resume */ }
      }
    }
  }
}
