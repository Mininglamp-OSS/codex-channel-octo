import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Config } from '../config.js';
import type { DbAdapter } from '../db-adapter.js';
import { ChannelType, type BotMessage } from '../octo/types.js';
import { sendMessage } from '../octo/api.js';
import { SessionRouter } from '../session-router.js';
import { queryAgentEvents } from '../agent-bridge.js';
import type { ManagedExecution } from '../execution-scope.js';
import { EndpointPermissionHost, type EndpointBinding, type EndpointHostPorts, type NativeHeader, type NativeIngress, type PermissionEndpoint, type PermissionKey } from './endpoint-host.js';
import { decodeControl, object, type ControlConnection, type RefusalRecord } from './control-client.js';
import { startPermissionCoordinator, type CoordinatorBoot } from './coordinator-process.js';
import { privateFile, verifyExecutable } from './private-files.js';
import { ReplayJournal } from './replay-journal.js';
import { createIsolatingWorkerLauncher, preparePrivateWorker, validRelayServerName, verifyHttpRelayTlsPin, type PrivateWorkerLaunch, type TurnRelay, type TurnRelayTrust } from './worker-launch.js';
import { catalogBootPin, verifyCatalogBoot } from './catalog-boot.js';
import type { OriginalIdentity } from './context-provenance.js';
import type { ReceivedDelivery } from './ingress-reservation.js';

/** Compiled trusted adapters, never imported from an operator/module path, MCP,
 * model output or a JSON claim. */
export interface NativeEndpointDriver extends Pick<EndpointHostPorts,
  'inspect' | 'candidate' | 'prepareInput' | 'publish' | 'refuse' | 'stop' | 'revalidateOriginal'> {
  /** Validate exclusive host ownership and authoritative native restore fence
   * before journal recovery or exposing the socket. This is not an allow bit. */
  recover(key: Readonly<PermissionKey>): Promise<void>;
}
export interface ContainedWorkerDriver {
  /** Own the actual isolated launch AND input/model/publication boundary;
   * maintain current Stage1/full-union/native gates at physical sinks. A
   * launcher hash, same-UID process group or successful callback is no proof. */
  execute: (binding: Parameters<EndpointHostPorts['runWorker']>[0], input: string,
    launch: Readonly<PrivateWorkerLaunch>, signal: AbortSignal) => Promise<string>;
  stop(): Promise<void>;
}
interface Dependencies { native: NativeEndpointDriver; worker: ContainedWorkerDriver }
export type ManagedPermissionFactory = (context: { config: Config; adapter: DbAdapter; botId: string }) => Promise<PermissionEndpoint>;

export interface NativeEndpointDriverOptions {
  readonly config: Config;
  readonly key: Readonly<PermissionKey>;
  readonly botId: string;
  readonly ownerUid?: string;
  readonly router?: SessionRouter;
  readonly fetchImpl?: typeof fetch;
}

export interface ContainedWorkerDriverOptions {
  readonly config: Config;
  readonly isolate?: {
    readonly root: string;
    readonly targetExecutable: string;
    readonly targetExecutableSha256: string;
    readonly deniedPaths: readonly string[];
    readonly allowNetwork?: boolean;
  };
  readonly runQuery?: typeof queryAgentEvents;
}

const NATIVE_FACTS_PATH = '/v1/bot/permission-facts/v1';
const NATIVE_BIND_DELIVERY_PATH = '/v1/bot/permission-facts/v1/bind-delivery';
const NATIVE_FENCE_PATH = '/v1/bot/permission-facts/v1/fence';

function channelTypeForSource(kind: NativeHeader['source']['kind']): ChannelType {
  if (kind === 'dm') return ChannelType.DM;
  if (kind === 'group') return ChannelType.Group;
  if (kind === 'thread') return ChannelType.CommunityTopic;
  throw new Error('Native source kind unavailable');
}

function verifyNativeAuthorities(rawAuthorities: unknown): void {
  const auth = object(rawAuthorities, ['sql', 'im']);
  for (const cut of [auth.sql, auth.im]) {
    const c = object(cut, ['authority_id', 'incarnation', 'commit_epoch', 'ack_before_read_start']);
    if (typeof c.authority_id !== 'string' || !c.authority_id
      || typeof c.incarnation !== 'string' || !/^[0-9a-f]{32}$/.test(c.incarnation)
      || typeof c.commit_epoch !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(c.commit_epoch)
      || c.ack_before_read_start !== true) {
      throw new Error('PERMISSION_NATIVE_AUTHORITY_CUT_INVALID');
    }
  }
}

function sameHeaderIdentity(actual: Readonly<Record<string, unknown>>, expected: Readonly<NativeHeader>, key: Readonly<PermissionKey>): void {
  const src = object(actual.source, ['kind', 'id']);
  if (actual.header_version !== 1
    || actual.header_reference !== expected.header_reference
    || actual.message_id !== expected.message_id
    || actual.space_id !== key.space_id
    || actual.recipient_bot_uid !== key.bot_uid
    || actual.author_uid !== expected.author_uid
    || actual.native_message_version !== expected.native_message_version
    || actual.payload_sha256 !== expected.payload_sha256
    || src.kind !== expected.source.kind
    || src.id !== expected.source.id) {
    throw new Error('PERMISSION_NATIVE_HEADER_MISMATCH');
  }
}

export function createNativeEndpointDriver(options: NativeEndpointDriverOptions): NativeEndpointDriver {
  const expectedKey = Object.freeze({ ...options.key });
  const router = options.router ?? new SessionRouter(options.config, options.botId, options.ownerUid ?? '');
  const fetchFn = options.fetchImpl ?? fetch;
  const apiUrl = options.config.apiUrl.replace(/\/+$/, '');
  const botToken = options.config.botToken;
  const deliveryRefByHeaderRef = new Map<string, string>();
  const boundPredicatesByHeaderRef = new Map<string, {
    proven: readonly string[];
    unknown: readonly string[];
    resolvablePurposes: readonly string[];
  }>();

  async function callNativeEndpoint(
    routePath: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    failureCode = 'PERMISSION_NATIVE_FACT_SOURCE_UNAVAILABLE',
  ): Promise<Record<string, unknown>> {
    let response: Response;
    const url = `${apiUrl}${routePath}?space_id=${encodeURIComponent(expectedKey.space_id)}`;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch {
      throw new Error(`${failureCode}: native authority endpoint unreachable`);
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw new Error(`${failureCode}: HTTP ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      throw new Error(`${failureCode}: invalid JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${failureCode}: malformed object`);
    }
    return parsed as Record<string, unknown>;
  }

  return {
    async recover(key: Readonly<PermissionKey>): Promise<void> {
      if (key.origin !== expectedKey.origin || key.bot_uid !== expectedKey.bot_uid || key.space_id !== expectedKey.space_id) {
        throw new Error('PERMISSION_NATIVE_AND_CONTAINMENT_BINDINGS_UNAVAILABLE: key mismatch');
      }
      const readId = randomBytes(16).toString('hex');
      const readNonce = randomBytes(16).toString('hex');
      const data = await callNativeEndpoint(
        NATIVE_FENCE_PATH,
        {
          space_id: expectedKey.space_id,
          read_id: readId,
          read_nonce: readNonce,
          requested_at: new Date().toISOString(),
        },
        AbortSignal.timeout(5000),
        'PERMISSION_NATIVE_AND_CONTAINMENT_BINDINGS_UNAVAILABLE',
      );
      if (data.fence_version !== 1
        || data.space_id !== expectedKey.space_id
        || data.read_id !== readId
        || data.read_nonce !== readNonce
        || typeof data.authority_id !== 'string' || !data.authority_id
        || typeof data.commit_marker !== 'string' || !data.commit_marker) {
        throw new Error('PERMISSION_NATIVE_AND_CONTAINMENT_BINDINGS_UNAVAILABLE: invalid fence response');
      }
      if (Object.hasOwn(data, 'recovery_fence_v1')) {
        const rf = object(data.recovery_fence_v1, ['sql_incarnation', 'im_incarnation', 'ack_before_read_start']);
        if (typeof rf.sql_incarnation !== 'string' || !/^[0-9a-f]{32}$/.test(rf.sql_incarnation)
          || typeof rf.im_incarnation !== 'string' || !/^[0-9a-f]{32}$/.test(rf.im_incarnation)
          || rf.ack_before_read_start !== true) {
          throw new Error('PERMISSION_NATIVE_AND_CONTAINMENT_BINDINGS_UNAVAILABLE: invalid recovery_fence_v1');
        }
        return;
      }
      if (Object.hasOwn(data, 'authorities')) {
        verifyNativeAuthorities(data.authorities);
        return;
      }
      // Production octo-server /v1/bot/permission-facts/v1/fence returns an ordinary
      // SQL read-time marker (octo-server-message-store) without a durable SQL+IM
      // crash/restore fence. Fail closed rather than mistaking it for recovery proof.
      throw new Error(
        'PERMISSION_NATIVE_AND_CONTAINMENT_BINDINGS_UNAVAILABLE: PERMISSION_NATIVE_RECOVERY_FENCE_UNAVAILABLE ' +
        '(ordinary SQL read-time marker is not a durable SQL+IM crash/restore fence)',
      );
    },

    async inspect(delivery: ReceivedDelivery): Promise<NativeIngress> {
      if (delivery.recipientUid !== expectedKey.bot_uid) {
        throw new Error('Native delivery recipient mismatch');
      }
      if (typeof delivery.message.channel_type !== 'number'
        || typeof delivery.message.channel_id !== 'string' || !delivery.message.channel_id
        || typeof delivery.message.message_id !== 'string' || !delivery.message.message_id
        || typeof delivery.message.from_uid !== 'string' || !delivery.message.from_uid
        || !Number.isSafeInteger(delivery.message.message_seq) || delivery.message.message_seq < 0) {
        throw new Error('Native delivery transport observation incomplete');
      }
      const requestId = randomBytes(16).toString('hex');
      const data = await callNativeEndpoint(
        NATIVE_BIND_DELIVERY_PATH,
        {
          schema_version: 1,
          request_id: requestId,
          operation: 'bind_delivery',
          channel_type: delivery.message.channel_type,
          channel_id: delivery.message.channel_id,
          message_id: delivery.message.message_id,
          message_seq: String(delivery.message.message_seq),
          from_uid: delivery.message.from_uid,
          observed_payload_sha256: delivery.payloadSha256,
        },
        AbortSignal.timeout(5000),
      );
      const reply = object(data, ['schema_version', 'request_id', 'authorities', 'binding']);
      if (reply.schema_version !== 1 || reply.request_id !== requestId) {
        throw new Error('Native bind_delivery response mismatch');
      }
      verifyNativeAuthorities(reply.authorities);
      const binding = object(reply.binding);
      if (binding.status !== 'bound' || binding.current !== true) {
        throw new Error(`Native delivery binding refused or non-current: ${String(binding.reason ?? binding.status)}`);
      }
      const deliveryReference = text(binding.delivery_reference);
      const headerReference = text(binding.header_reference);
      const nativeMessageVersion = text(binding.native_message_version);
      if (!/^s1-[A-Za-z0-9_-]{1,509}$/.test(deliveryReference)
        || !/^h1-[A-Za-z0-9_-]{1,509}$/.test(headerReference)
        || binding.observed_payload_sha256 !== delivery.payloadSha256) {
        throw new Error('Native delivery binding tokens invalid');
      }
      const proven = Array.isArray(binding.proven_predicates) ? binding.proven_predicates.map(String) : [];
      const unknown = Array.isArray(binding.unknown_predicates) ? binding.unknown_predicates.map(String) : [];
      const resolvablePurposes = Array.isArray(binding.resolvable_purposes) ? binding.resolvable_purposes.map(String) : [];
      if (!proven.includes('delivery_current_exact')
        || !proven.includes('sender_identity_exact')
        || !proven.includes('message_space_exact')
        || unknown.includes('message_space_exact')) {
        throw new Error('Native delivery required predicates unproven');
      }
      const rawHeader = object(binding.header);
      if (rawHeader.header_reference !== headerReference
        || rawHeader.native_message_version !== nativeMessageVersion
        || rawHeader.payload_sha256 !== delivery.payloadSha256
        || rawHeader.space_id !== expectedKey.space_id
        || rawHeader.recipient_bot_uid !== expectedKey.bot_uid) {
        throw new Error('Native bound header mismatch');
      }
      if (deliveryRefByHeaderRef.size >= 4096) {
        const oldest = deliveryRefByHeaderRef.keys().next().value;
        if (oldest !== undefined) {
          deliveryRefByHeaderRef.delete(oldest);
          boundPredicatesByHeaderRef.delete(oldest);
        }
      }
      deliveryRefByHeaderRef.set(headerReference, deliveryReference);
      boundPredicatesByHeaderRef.set(headerReference, {
        proven: Object.freeze(proven),
        unknown: Object.freeze(unknown),
        resolvablePurposes: Object.freeze(resolvablePurposes),
      });
      return {
        deliveryReference,
        header: rawHeader as unknown as NativeHeader,
      };
    },

    async candidate(message: BotMessage): Promise<boolean> {
      const routed = await router.route(message);
      return Boolean(routed && routed.shouldProcess);
    },

    async revalidateOriginal(
      original: Readonly<OriginalIdentity>,
      header: Readonly<NativeHeader>,
      signal: AbortSignal,
    ): Promise<'allow' | 'deny' | 'unknown'> {
      try {
        const effectiveSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        const requestId = randomBytes(16).toString('hex');
        const data = await callNativeEndpoint(
          NATIVE_FACTS_PATH,
          {
            schema_version: 1,
            profile_version: 1,
            request_id: requestId,
            operation: 'history_disclosure',
            context_id: 'revalidation',
            context_epoch: 0,
            headers: [{ header_reference: original.headerReference }],
          },
          effectiveSignal,
        );
        if (data.schema_version !== 1 || data.profile_version !== 1 || data.request_id !== requestId) {
          return 'unknown';
        }
        verifyNativeAuthorities(data.authorities);
        if (!Array.isArray(data.results) || data.results.length !== 1) return 'unknown';
        const result = object(data.results[0]);
        if (result.header_reference !== original.headerReference) return 'unknown';
        if (result.status === 'redacted' || result.status === 'refused') return 'deny';
        if (result.status !== 'disclosed') return 'unknown';
        const disclosedHeader = object(result.header);
        if (disclosedHeader.header_reference !== original.headerReference
          || disclosedHeader.space_id !== expectedKey.space_id
          || disclosedHeader.recipient_bot_uid !== expectedKey.bot_uid) {
          return 'deny';
        }
        if (disclosedHeader.native_message_version !== original.messageVersion
          || disclosedHeader.payload_sha256 !== original.payloadSha256) {
          return 'deny';
        }
        if (typeof result.content !== 'string'
          || createHash('sha256').update(result.content, 'utf8').digest('hex') !== original.payloadSha256) {
          return 'deny';
        }
        sameHeaderIdentity(disclosedHeader, header, expectedKey);
        return 'allow';
      } catch {
        return 'unknown';
      }
    },

    async prepareInput(binding: Readonly<EndpointBinding>, signal: AbortSignal): Promise<{
      input: string;
      originals: readonly Readonly<NativeHeader>[];
      contributorReferences?: readonly string[];
    }> {
      const boundPredicates = boundPredicatesByHeaderRef.get(binding.header.header_reference);
      if (boundPredicates && (
        boundPredicates.unknown.includes('bot_original_visible')
        || boundPredicates.unknown.includes('caller_original_visible')
      )) {
        throw new Error('PERMISSION_NATIVE_ORIGINAL_VISIBILITY_UNKNOWN: bind_delivery reported unknown original visibility');
      }
      const effectiveSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      const requestId = randomBytes(16).toString('hex');
      const rawEpoch = Number(binding.contextEpoch ?? '0');
      const contextEpoch = Number.isSafeInteger(rawEpoch) && rawEpoch >= 0 ? rawEpoch : 0;
      const data = await callNativeEndpoint(
        NATIVE_FACTS_PATH,
        {
          schema_version: 1,
          profile_version: 1,
          request_id: requestId,
          operation: 'history_disclosure',
          context_id: binding.contextId,
          context_epoch: contextEpoch,
          headers: [{ header_reference: binding.header.header_reference }],
        },
        effectiveSignal,
      );
      if (data.schema_version !== 1 || data.profile_version !== 1 || data.request_id !== requestId) {
        throw new Error('Native history_disclosure response mismatch');
      }
      verifyNativeAuthorities(data.authorities);
      if (!Array.isArray(data.results) || data.results.length < 1) {
        throw new Error('Native history_disclosure results invalid');
      }
      const primary = object(data.results[0]);
      if (primary.header_reference !== binding.header.header_reference) {
        throw new Error('Native history_disclosure header_reference mismatch');
      }
      if (primary.status !== 'disclosed') {
        throw new Error(`PERMISSION_NATIVE_ORIGINAL_VISIBILITY_UNKNOWN: status=${String(primary.status)} reason=${String(primary.reason ?? 'unknown')}`);
      }
      const disclosedHeader = object(primary.header);
      sameHeaderIdentity(disclosedHeader, binding.header, expectedKey);
      if (typeof primary.content !== 'string'
        || createHash('sha256').update(primary.content, 'utf8').digest('hex') !== binding.header.payload_sha256) {
        throw new Error('Native history_disclosure payload sha256 mismatch');
      }
      let extractedInput = primary.content;
      try {
        const parsedContent = JSON.parse(primary.content) as Record<string, unknown>;
        if (parsedContent && typeof parsedContent === 'object' && !Array.isArray(parsedContent) && typeof parsedContent.content === 'string') {
          extractedInput = parsedContent.content;
        }
      } catch {
        // Plain-text payload whose UTF-8 bytes directly hash to payload_sha256.
      }
      const disclosedOriginals: Readonly<NativeHeader>[] = [disclosedHeader as unknown as Readonly<NativeHeader>];
      for (let i = 1; i < data.results.length; i++) {
        const extra = object(data.results[i]);
        if (extra.status !== 'disclosed') {
          throw new Error('PERMISSION_NATIVE_ORIGINAL_VISIBILITY_UNKNOWN: historical contributor not disclosed');
        }
        disclosedOriginals.push(object(extra.header) as unknown as Readonly<NativeHeader>);
      }
      const rawRefs = Object.hasOwn(data, 'contributor_references')
        ? data.contributor_references
        : Object.hasOwn(primary, 'contributor_references')
          ? primary.contributor_references
          : undefined;
      if (rawRefs !== undefined && (!Array.isArray(rawRefs) || rawRefs.some(r => typeof r !== 'string' || !r))) {
        throw new Error('Native disclosure contributor references invalid');
      }
      return {
        input: extractedInput,
        originals: disclosedOriginals,
        ...(rawRefs && rawRefs.length > 0 ? { contributorReferences: rawRefs as readonly string[] } : {}),
      };
    },

    async publish(binding: Readonly<EndpointBinding>, outputText: string, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (typeof outputText !== 'string' || !outputText.trim()) {
        throw new Error('Publication text unavailable');
      }
      const deliveryReference = deliveryRefByHeaderRef.get(binding.header.header_reference);
      if (!deliveryReference || !/^s1-[A-Za-z0-9_-]{1,509}$/.test(deliveryReference)) {
        throw new Error('Native reply delivery reference unavailable');
      }
      const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      const requestId = randomBytes(16).toString('hex');
      const check = await callNativeEndpoint(
        NATIVE_FACTS_PATH,
        {
          schema_version: 1,
          profile_version: 1,
          request_id: requestId,
          operation: 'resolve',
          purpose: 'reply',
          references: [{ delivery_reference: deliveryReference }],
        },
        checkSignal,
      );
      if (check.schema_version !== 1 || check.profile_version !== 1 || check.request_id !== requestId) {
        throw new Error('Native reply resolve response mismatch');
      }
      verifyNativeAuthorities(check.authorities);
      if (!Array.isArray(check.results) || check.results.length !== 1) {
        throw new Error('Native reply resolve results invalid');
      }
      const resolved = object(check.results[0]);
      if (resolved.delivery_reference !== deliveryReference || resolved.status !== 'resolved') {
        throw new Error('Native reply route denied');
      }
      sameHeaderIdentity(object(resolved.header), binding.header, expectedKey);
      signal.throwIfAborted();
      // Single-attempt original-route publication (NoRetry). Any error after
      // request initiation propagates as unknown-effect failure.
      await sendMessage({
        apiUrl,
        botToken,
        channelId: binding.header.source.id,
        channelType: channelTypeForSource(binding.header.source.kind),
        content: outputText,
        replyMsgId: binding.header.message_id,
        signal,
      });
    },

    async refuse(
      ingress: Readonly<NativeIngress>,
      _record: Readonly<RefusalRecord>,
      refusalText: string,
      signal: AbortSignal,
    ): Promise<void> {
      if (!/^s1-[A-Za-z0-9_-]{1,509}$/.test(ingress.deliveryReference)) return;
      const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
      const requestId = randomBytes(16).toString('hex');
      const check = await callNativeEndpoint(
        NATIVE_FACTS_PATH,
        {
          schema_version: 1,
          profile_version: 1,
          request_id: requestId,
          operation: 'resolve',
          purpose: 'reply',
          references: [{ delivery_reference: ingress.deliveryReference }],
        },
        boundedSignal,
      );
      if (check.schema_version !== 1 || check.profile_version !== 1 || check.request_id !== requestId) return;
      verifyNativeAuthorities(check.authorities);
      if (!Array.isArray(check.results) || check.results.length !== 1) return;
      const resolved = object(check.results[0]);
      if (resolved.delivery_reference !== ingress.deliveryReference || resolved.status !== 'resolved') return;
      sameHeaderIdentity(object(resolved.header), ingress.header, expectedKey);
      await sendMessage({
        apiUrl,
        botToken,
        channelId: ingress.header.source.id,
        channelType: channelTypeForSource(ingress.header.source.kind),
        content: refusalText,
        replyMsgId: ingress.header.message_id,
        signal: boundedSignal,
      });
    },

    async stop(): Promise<void> {
      await router.stopTurns(3000);
    },
  };
}

export function createContainedWorkerDriver(options: ContainedWorkerDriverOptions): ContainedWorkerDriver {
  const activeExecutions = new Set<ManagedExecution>();
  const runQuery = options.runQuery ?? queryAgentEvents;
  let pinnedIsolator: ReturnType<typeof createIsolatingWorkerLauncher> | undefined;
  let stopped = false;

  function ensureIsolator(): ReturnType<typeof createIsolatingWorkerLauncher> | undefined {
    if (!options.isolate) return undefined;
    return pinnedIsolator ??= createIsolatingWorkerLauncher(options.isolate);
  }

  return {
    async execute(binding, input, launch, signal): Promise<string> {
      if (stopped) throw new Error('Contained worker driver stopped');
      signal.throwIfAborted();
      const isolator = ensureIsolator();
      const effectiveLaunch: Readonly<PrivateWorkerLaunch> = isolator
        ? Object.freeze({ ...launch, launcher: isolator.launcher })
        : launch;
      const turnExecutions: ManagedExecution[] = [];
      let sessionBound = Boolean(binding.verifiedResume?.workdir);
      let answer = '';
      try {
        if (effectiveLaunch.relayUrl) {
          await verifyHttpRelayTlsPin(effectiveLaunch, signal);
        }
        for await (const event of runQuery(input, options.config, undefined, undefined, {
          privateWorker: effectiveLaunch,
          signal,
          resume: binding.verifiedResume?.sessionId,
          onManagedExecution: execution => {
            activeExecutions.add(execution);
            turnExecutions.push(execution);
          },
          onSessionId: sessionId => {
            binding.bindSession?.(sessionId, {
              workdir: effectiveLaunch.workdir,
              codexHome: effectiveLaunch.codexHome,
            });
            sessionBound = true;
          },
        })) {
          signal.throwIfAborted();
          if (event.kind === 'message') answer = event.text;
        }
      } finally {
        for (const execution of turnExecutions) {
          const exited = await execution.waitForStopped(3000);
          execution.dispose();
          activeExecutions.delete(execution);
          if (!exited) throw new Error('Contained worker execution did not stop within grace period');
        }
        if (!sessionBound && !binding.verifiedResume?.workdir) {
          try {
            const genDir = dirname(effectiveLaunch.workdir);
            if (genDir && genDir !== effectiveLaunch.workdir) {
              rmSync(genDir, { recursive: true, force: true });
            }
          } catch { /* best-effort cleanup of unreferenced generation dir */ }
        }
      }
      if (!answer) throw new Error('Contained worker produced no output');
      return answer;
    },

    async stop(): Promise<void> {
      stopped = true;
      const pending = [...activeExecutions];
      activeExecutions.clear();
      const results = await Promise.all(pending.map(async execution => {
        const ok = await execution.waitForStopped(3000);
        execution.dispose();
        return ok;
      }));
      if (results.some(ok => !ok)) {
        throw new Error('Contained worker failed to stop cleanly');
      }
    },
  };
}

interface Descriptor {
  key: Readonly<PermissionKey>;
  recipientId: string;
  transport: 'http' | 'stdio';
  boot: Omit<CoordinatorBoot, 'botToken' | 'origin' | 'botUid' | 'recipientId'>;
  journalKey: Buffer;
  journalKeyPath: string;
  journalKeyVersion: string;
  provision: boolean;
  tlsPaths: readonly string[];
  worker: { root: string; launcher: string; launcherSha256: string; instructions: string;
    provider?: { baseUrl: string; apiKey?: string } };
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Managed descriptor invalid');
  return value;
}

function readDescriptor(path: string): Descriptor {
  const d = decodeControl(privateFile(path, 16384));
  object(d, ['version', 'key', 'recipient_id', 'transport', 'coordinator', 'tls', 'journal', 'worker', ...(d.version === 2 ? ['catalog'] : [])]);
  if (![1, 2].includes(Number(d.version)) || typeof d.version !== 'number'
    || !['stdio', 'http'].includes(String(d.transport))) throw new Error('Managed descriptor invalid');
  const key = object(d.key, ['origin', 'bot_uid', 'space_id']);
  const permissionKey = Object.freeze({ origin: text(key.origin), bot_uid: text(key.bot_uid), space_id: text(key.space_id) });
  const coordinator = object(d.coordinator, ['root', 'executable', 'sha256', 'host_config']);
  const hostConfigPath = text(coordinator.host_config);
  const hostConfig = object(decodeControl(privateFile(hostConfigPath, 16384)));
  const catalog = verifyCatalogBoot(hostConfig, d.version === 2 ? catalogBootPin(d.catalog) : undefined);
  const tls = object(d.tls, ['host', 'port', 'servername', 'ca', 'cert', 'key', 'peer_sha256']);
  if (!Number.isInteger(tls.port) || Number(tls.port) < 1 || Number(tls.port) > 65535) throw new Error('Managed descriptor invalid');
  const tlsCaPath = text(tls.ca);
  const tlsCertPath = text(tls.cert);
  const tlsKeyPath = text(tls.key);
  const connection: Omit<ControlConnection, 'configuredOrigin' | 'recipientId' | 'endpointIncarnation' | 'coordinatorIncarnation'> = {
    host: text(tls.host), port: Number(tls.port), servername: text(tls.servername), peerCertificateSha256: text(tls.peer_sha256),
    ca: privateFile(tlsCaPath, 65536), cert: privateFile(tlsCertPath, 65536), key: privateFile(tlsKeyPath, 65536),
  };
  const journal = object(d.journal, ['key', 'key_version', 'provision']);
  if (typeof journal.provision !== 'boolean') throw new Error('Managed descriptor invalid');
  const journalKeyPath = text(journal.key);
  const worker = object(d.worker, ['root', 'launcher', 'sha256', 'instructions', 'provider']);
  let provider: Descriptor['worker']['provider'];
  const extraProtectedPaths: string[] = [path, hostConfigPath, tlsCaPath, tlsCertPath, tlsKeyPath, journalKeyPath];
  if (worker.provider !== null) {
    const p = object(worker.provider, ['base_url', 'api_key_file']);
    provider = { baseUrl: text(p.base_url) };
    if (p.api_key_file !== null) {
      const apiKeyPath = text(p.api_key_file);
      extraProtectedPaths.push(apiKeyPath);
      provider.apiKey = privateFile(apiKeyPath, 16384).toString('utf8').trim();
    }
  }
  return { key: permissionKey, recipientId: text(d.recipient_id), transport: d.transport as Descriptor['transport'],
    boot: { root: text(coordinator.root), executable: text(coordinator.executable), executableSha256: text(coordinator.sha256),
      hostConfig, tls: connection, catalog }, journalKey: privateFile(journalKeyPath, 32), journalKeyPath,
    journalKeyVersion: text(journal.key_version), provision: journal.provision,
    tlsPaths: Object.freeze(extraProtectedPaths),
    worker: { root: text(worker.root), launcher: text(worker.launcher),
      launcherSha256: text(worker.sha256), instructions: text(worker.instructions), ...(provider ? { provider } : {}) } };
}

function resolveConfiguredRelayCaBytes(
  hostConfig: Readonly<Record<string, unknown>>,
  bootTlsCa?: Uint8Array | string,
): Buffer | undefined {
  const configuredCa = typeof hostConfig.relay_ca === 'string' && hostConfig.relay_ca
    ? hostConfig.relay_ca
    : typeof hostConfig.peer_ca === 'string' && hostConfig.peer_ca
      ? hostConfig.peer_ca
      : undefined;
  if (configuredCa && isAbsolute(configuredCa) && existsSync(configuredCa)) {
    const stat = lstatSync(configuredCa);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 256 * 1024) {
      return readFileSync(configuredCa);
    }
  }
  if (bootTlsCa !== undefined) {
    return typeof bootTlsCa === 'string' ? Buffer.from(bootTlsCa, 'utf8') : Buffer.from(bootTlsCa);
  }
  return undefined;
}

function checkTurnRelayTrust(
  rawTls: unknown,
  hostConfig: Readonly<Record<string, unknown>>,
  fallbackCaBytes?: Buffer,
): Readonly<TurnRelayTrust> {
  const obj = object(rawTls);
  const allowed = new Set(['ca_file', 'ca_pem', 'ca_sha256', 'peer_sha256', 'cert_sha256', 'server_name']);
  const keys = Object.keys(obj);
  if (keys.length === 0 || keys.some(k => !allowed.has(k))) {
    throw new Error('Relay TLS trust invalid');
  }
  const out: {
    ca_file?: string;
    ca_pem?: string;
    ca_sha256?: string;
    peer_sha256?: string;
    cert_sha256?: string;
    server_name?: string;
  } = {};
  let caBytes: Buffer | undefined = fallbackCaBytes;
  if (Object.hasOwn(obj, 'ca_file')) {
    const caFile = text(obj.ca_file);
    if (!isAbsolute(caFile) || /[\r\n\0]/.test(caFile)) throw new Error('Relay TLS trust invalid');
    const configuredCa = typeof hostConfig.relay_ca === 'string' && hostConfig.relay_ca
      ? hostConfig.relay_ca
      : typeof hostConfig.peer_ca === 'string' && hostConfig.peer_ca
        ? hostConfig.peer_ca
        : undefined;
    if (configuredCa !== undefined && caFile !== configuredCa) {
      throw new Error('Relay TLS CA binding conflict');
    }
    if (existsSync(caFile)) {
      const stat = lstatSync(caFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 256 * 1024) {
        throw new Error('Relay TLS CA file invalid');
      }
      caBytes = readFileSync(caFile);
    }
    out.ca_file = caFile;
  }
  if (Object.hasOwn(obj, 'ca_pem')) {
    const caPem = text(obj.ca_pem);
    const pemBytes = Buffer.from(caPem, 'utf8');
    if (pemBytes.byteLength === 0 || pemBytes.byteLength > 256 * 1024 || !caPem.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('Relay TLS CA bundle invalid');
    }
    if (out.ca_file && caBytes && Buffer.compare(caBytes, pemBytes) !== 0) {
      throw new Error('Relay TLS CA bundle conflict');
    }
    caBytes = pemBytes;
    out.ca_pem = caPem;
  }
  if (Object.hasOwn(obj, 'ca_sha256')) {
    const caSha = text(obj.ca_sha256);
    if (!/^[0-9a-f]{64}$/.test(caSha)) throw new Error('Relay TLS trust invalid');
    if (typeof hostConfig.relay_ca_sha256 === 'string' && hostConfig.relay_ca_sha256 && caSha !== hostConfig.relay_ca_sha256) {
      throw new Error('Relay TLS CA digest conflict');
    }
    if (caBytes && createHash('sha256').update(caBytes).digest('hex') !== caSha) {
      throw new Error('Relay TLS CA digest conflict');
    }
    out.ca_sha256 = caSha;
  } else if (typeof hostConfig.relay_ca_sha256 === 'string' && hostConfig.relay_ca_sha256) {
    if (!/^[0-9a-f]{64}$/.test(hostConfig.relay_ca_sha256)) throw new Error('Relay TLS trust invalid');
    if (caBytes && createHash('sha256').update(caBytes).digest('hex') !== hostConfig.relay_ca_sha256) {
      throw new Error('Relay TLS CA digest conflict');
    }
  }
  const configuredPeerPin = typeof hostConfig.relay_cert_sha256 === 'string' && hostConfig.relay_cert_sha256
    ? hostConfig.relay_cert_sha256
    : typeof hostConfig.relay_peer_sha256 === 'string' && hostConfig.relay_peer_sha256
      ? hostConfig.relay_peer_sha256
      : undefined;
  if (Object.hasOwn(obj, 'peer_sha256')) {
    const peerSha = text(obj.peer_sha256);
    if (!/^[0-9a-f]{64}$/.test(peerSha)) throw new Error('Relay TLS trust invalid');
    if (configuredPeerPin && peerSha !== configuredPeerPin) {
      throw new Error('Relay TLS certificate pin conflict');
    }
    out.peer_sha256 = peerSha;
  }
  if (Object.hasOwn(obj, 'cert_sha256')) {
    const certSha = text(obj.cert_sha256);
    if (!/^[0-9a-f]{64}$/.test(certSha)) throw new Error('Relay TLS trust invalid');
    if (configuredPeerPin && certSha !== configuredPeerPin) {
      throw new Error('Relay TLS certificate pin conflict');
    }
    out.cert_sha256 = certSha;
  }
  if (out.peer_sha256 !== undefined && out.cert_sha256 !== undefined && out.peer_sha256 !== out.cert_sha256) {
    throw new Error('Relay TLS certificate pin conflict');
  }
  if (Object.hasOwn(obj, 'server_name')) {
    const serverName = text(obj.server_name);
    if (!validRelayServerName(serverName)) throw new Error('Relay TLS trust invalid');
    if (typeof hostConfig.relay_server_name === 'string' && hostConfig.relay_server_name && serverName !== hostConfig.relay_server_name) {
      throw new Error('Relay TLS server_name conflict');
    }
    out.server_name = serverName;
  }
  return Object.freeze(out);
}

/** Exact closed relay reply. Pin the stdio executable to the selected CLI, not
 * merely to a digest supplied by another reply field. HTTP stays HTTPS. */
export function checkedTurnRelay(
  value: Readonly<Record<string, unknown>>,
  boot: Pick<CoordinatorBoot, 'executable' | 'executableSha256' | 'hostConfig'> & {
    tls?: { ca?: Uint8Array | string };
  },
  transport: 'http' | 'stdio',
): TurnRelay {
  if (value.transport !== transport) throw new Error('Relay transport conflict');
  const fallbackCaBytes = resolveConfiguredRelayCaBytes(boot.hostConfig, boot.tls?.ca);
  const hasTls = Object.hasOwn(value, 'tls');
  const replyTls = hasTls ? checkTurnRelayTrust(value.tls, boot.hostConfig, fallbackCaBytes) : undefined;
  if (transport === 'stdio') {
    const relay = object(
      value,
      hasTls
        ? ['transport', 'executable', 'executableSha256', 'handle', 'tls']
        : ['transport', 'executable', 'executableSha256', 'handle'],
    );
    if (relay.executable !== boot.executable || relay.executableSha256 !== boot.executableSha256) throw new Error('Relay executable conflict');
    verifyExecutable(boot.executable, boot.executableSha256);
    const handle = text(relay.handle);
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(handle)) throw new Error('Relay ticket invalid');
    const bytes = Buffer.from(handle, 'base64url');
    if (bytes.toString('base64url') !== handle) throw new Error('Relay ticket invalid');
    const rawTicket = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const allowedTicketKeys = ['ca_file', 'ca_sha256', 'cert_sha256', 'endpoint', 'peer_sha256', 'server_name', 'token'];
    const presentTicketKeys = Object.keys(rawTicket);
    if (!Object.hasOwn(rawTicket, 'endpoint') || !Object.hasOwn(rawTicket, 'token')
      || presentTicketKeys.some(k => !allowedTicketKeys.includes(k))) {
      throw new Error('Relay ticket invalid');
    }
    // The producer uses Go json.Marshal(map[string]string) for this ticket
    // (sorted keys plus HTML and line-separator escapes).
    const orderedTicket: Record<string, unknown> = {};
    for (const k of allowedTicketKeys) {
      if (Object.hasOwn(rawTicket, k)) orderedTicket[k] = rawTicket[k];
    }
    const encoded = JSON.stringify(orderedTicket)
      .replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (encoded !== bytes.toString('utf8')) throw new Error('Relay ticket invalid');
    if (rawTicket.endpoint !== boot.hostConfig.relay_url || !/^[0-9a-f]{64}$/.test(text(rawTicket.token))) {
      throw new Error('Relay binding conflict');
    }
    const ticketTrustKeys = ['ca_file', 'ca_sha256', 'cert_sha256', 'peer_sha256', 'server_name'].filter(k => Object.hasOwn(rawTicket, k));
    let ticketTls: Readonly<TurnRelayTrust> | undefined;
    if (ticketTrustKeys.length > 0) {
      const rawTrust: Record<string, unknown> = {};
      for (const k of ticketTrustKeys) rawTrust[k] = rawTicket[k];
      ticketTls = checkTurnRelayTrust(rawTrust, boot.hostConfig, fallbackCaBytes);
    }
    if (replyTls && ticketTls) {
      const replyPeer = replyTls.cert_sha256 ?? replyTls.peer_sha256;
      const ticketPeer = ticketTls.cert_sha256 ?? ticketTls.peer_sha256;
      if ((replyTls.ca_file !== undefined && ticketTls.ca_file !== undefined && replyTls.ca_file !== ticketTls.ca_file)
        || (replyTls.ca_sha256 !== undefined && ticketTls.ca_sha256 !== undefined && replyTls.ca_sha256 !== ticketTls.ca_sha256)
        || (replyPeer !== undefined && ticketPeer !== undefined && replyPeer !== ticketPeer)
        || (replyTls.server_name !== undefined && ticketTls.server_name !== undefined && replyTls.server_name !== ticketTls.server_name)) {
        throw new Error('Relay TLS trust conflict');
      }
    }
    const url = new URL(text(rawTicket.endpoint));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Relay URL invalid');
    const effectiveTls = replyTls ?? ticketTls;
    return {
      transport,
      executable: boot.executable,
      executableSha256: boot.executableSha256,
      handle,
      ...(effectiveTls ? { tls: effectiveTls } : {}),
    };
  }
  const hasHttpPin = Object.hasOwn(value, 'ca_sha256') || Object.hasOwn(value, 'peer_sha256');
  const expectedHttpKeys = [
    'transport',
    'url',
    'handle',
    ...(hasTls ? ['tls'] : []),
    ...(hasHttpPin ? ['ca_sha256', 'peer_sha256'] : []),
  ];
  const relay = object(value, expectedHttpKeys);
  if (relay.url !== boot.hostConfig.relay_url || !/^[0-9a-f]{64}$/.test(text(relay.handle))) throw new Error('Relay binding conflict');
  if (hasHttpPin) {
    const caSha = text(relay.ca_sha256);
    const peerSha = text(relay.peer_sha256);
    if (!/^[0-9a-f]{64}$/.test(caSha) || !/^[0-9a-f]{64}$/.test(peerSha)) {
      throw new Error('Relay binding conflict');
    }
    const configuredPeerPin = typeof boot.hostConfig.relay_cert_sha256 === 'string' && boot.hostConfig.relay_cert_sha256
      ? boot.hostConfig.relay_cert_sha256
      : typeof boot.hostConfig.relay_peer_sha256 === 'string' && boot.hostConfig.relay_peer_sha256
        ? boot.hostConfig.relay_peer_sha256
        : undefined;
    if (configuredPeerPin && peerSha !== configuredPeerPin) {
      throw new Error('Relay TLS certificate pin conflict');
    }
    if (replyTls?.ca_sha256 && replyTls.ca_sha256 !== caSha) {
      throw new Error('Relay TLS CA digest conflict');
    }
    const replyPeer = replyTls?.cert_sha256 ?? replyTls?.peer_sha256;
    if (replyPeer && replyPeer !== peerSha) {
      throw new Error('Relay TLS certificate pin conflict');
    }
    const caBytesToCheck = replyTls?.ca_pem
      ? Buffer.from(replyTls.ca_pem, 'utf8')
      : replyTls?.ca_file && existsSync(replyTls.ca_file)
        ? readFileSync(replyTls.ca_file)
        : fallbackCaBytes;
    if (caBytesToCheck && createHash('sha256').update(caBytesToCheck).digest('hex') !== caSha) {
      throw new Error('Relay TLS CA digest conflict');
    }
  }
  const url = new URL(text(relay.url));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Relay URL invalid');
  return {
    transport,
    url: text(relay.url),
    handle: text(relay.handle),
    ...(replyTls ? { tls: replyTls } : {}),
    ...(hasHttpPin ? { caSha256: text(relay.ca_sha256), peerSha256: text(relay.peer_sha256) } : {}),
  };
}

/** Per-bot opt-in. Presence selects managed mode before any legacy data loads;
 * unreadable/invalid/stale descriptors fail startup, never downgrade. */
export function managedPermissionFactory(config: Config, dependencies?: Dependencies): ManagedPermissionFactory | undefined {
  // Older library callers can omit the global per-bot config root. Production
  // loadConfig/resolveBotConfigs always supplies it; no descriptor is inferred
  // from a working directory or another bot's data path.
  if (config.baseDir === undefined) return undefined;
  if (!config.botId || !/^[A-Za-z0-9._-]+$/.test(config.botId) || ['.', '..'].includes(config.botId)) return undefined;
  const path = join(config.baseDir, config.botId, 'permission-endpoint.json');
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const descriptor = readDescriptor(path);
  return async ({ config: current, adapter, botId }) => {
    if (descriptor.key.origin !== current.apiUrl || descriptor.key.bot_uid !== botId) throw new Error('Managed Bot binding conflict');
    const deniedPaths = [
      descriptor.boot.root,
      dirname(path),
      ...(current.dataDir ? [current.dataDir] : []),
      ...descriptor.tlsPaths,
    ];
    const activeDependencies: Dependencies = dependencies ?? {
      native: createNativeEndpointDriver({
        config: current,
        key: descriptor.key,
        botId,
      }),
      worker: createContainedWorkerDriver({
        config: current,
        isolate: {
          root: descriptor.worker.root,
          targetExecutable: descriptor.worker.launcher,
          targetExecutableSha256: descriptor.worker.launcherSha256,
          deniedPaths,
          allowNetwork: Boolean(descriptor.worker.provider),
        },
      }),
    };
    let coordinator: Awaited<ReturnType<typeof startPermissionCoordinator>> | undefined;
    let stopped: Promise<void> | undefined;
    const stop = (): Promise<void> => stopped ??= (async () => {
      // Stop workers/native operations before releasing private host authority.
      const results = await Promise.allSettled([activeDependencies.worker.stop(), activeDependencies.native.stop()]);
      await coordinator?.stop();
      if (results.some(result => result.status === 'rejected')) throw new Error('Managed shutdown requires quarantine');
    })();
    try {
      await activeDependencies.native.recover(descriptor.key);
      const journal = new ReplayJournal(adapter, descriptor.journalKey, descriptor.journalKeyVersion, {
        provision: descriptor.provision,
        exclusive: true,
      });
      journal.recoverInterrupted();
      coordinator = await startPermissionCoordinator({ ...descriptor.boot, botToken: current.botToken,
        origin: descriptor.key.origin, botUid: botId, recipientId: descriptor.recipientId });
      const native = activeDependencies.native;
      return new EndpointPermissionHost({ key: descriptor.key, recipientId: descriptor.recipientId, relayTransport: descriptor.transport,
        journal, control: coordinator.control, authoritySignal: coordinator.signal, catalog: coordinator.catalog,
        inspect: delivery => native.inspect(delivery), candidate: message => native.candidate(message),
        ...(native.revalidateOriginal ? { revalidateOriginal: (orig, hdr, sig) => native.revalidateOriginal!(orig, hdr, sig) } : {}),
        prepareInput: (binding, signal) => native.prepareInput(binding, signal),
        publish: (binding, output, signal) => native.publish(binding, output, signal),
        refuse: (ingress, record, output, signal) => native.refuse(ingress, record, output, signal),
        runWorker: (binding, input, relay, signal) => {
          const verifiedRelay = checkedTurnRelay(relay, descriptor.boot, descriptor.transport);
          const relayWithCa: TurnRelay = verifiedRelay.tls?.ca_file
            ? verifiedRelay
            : { ...verifiedRelay, caCert: descriptor.boot.tls.ca };
          return activeDependencies.worker.execute(
            binding,
            input,
            preparePrivateWorker({
              ...descriptor.worker,
              relay: relayWithCa,
              ...(binding.verifiedResume ? { verifiedResume: binding.verifiedResume } : {}),
            }),
            signal,
          );
        }, stop });
    } catch (error) { await stop(); throw error; }
  };
}
