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
import { createIsolatingWorkerLauncher, preparePrivateWorker, startTurnRelayBridge, validRelayServerName, type PrivateWorkerLaunch, type TurnRelay, type TurnRelayBridge, type TurnRelayTrust } from './worker-launch.js';
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
  /** Isolated synthetic test hook only; production startup has no recovery fence route on octo-server v7. */
  readonly syntheticRecoveryFence?: Readonly<{
    readonly sql_incarnation: string;
    readonly im_incarnation: string;
    readonly ack_before_read_start: boolean;
  }>;
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

function channelTypeForSource(kind: NativeHeader['source']['kind']): ChannelType {
  if (kind === 'dm') return ChannelType.DM;
  if (kind === 'group') return ChannelType.Group;
  if (kind === 'thread') return ChannelType.CommunityTopic;
  throw new Error('Native source kind unavailable');
}

function verifyNativeAuthorities(rawAuthorities: unknown): ReadonlyMap<string, 'sql' | 'im'> {
  if (!Array.isArray(rawAuthorities) || rawAuthorities.length !== 2) {
    throw new Error('PERMISSION_NATIVE_AUTHORITY_CUT_INVALID');
  }
  const nonceToKind = new Map<string, 'sql' | 'im'>();
  const seenKinds = new Set<string>();
  for (const item of rawAuthorities) {
    const c = object(item, [
      'authority_id',
      'kind',
      'incarnation',
      'position',
      'read_nonce',
      'consistency',
      'started_at',
      'completed_at',
    ]);
    if (typeof c.authority_id !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(c.authority_id)
      || (c.kind !== 'sql' && c.kind !== 'im')
      || typeof c.incarnation !== 'string' || !/^[0-9a-f]{32}$/.test(c.incarnation)
      || typeof c.position !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(c.position)
      || typeof c.read_nonce !== 'string' || !/^[0-9a-f]{32}$/.test(c.read_nonce)
      || c.consistency !== 'ack_before_read_start'
      || typeof c.started_at !== 'string' || Number.isNaN(Date.parse(c.started_at))
      || typeof c.completed_at !== 'string' || Number.isNaN(Date.parse(c.completed_at))) {
      throw new Error('PERMISSION_NATIVE_AUTHORITY_CUT_INVALID');
    }
    if (nonceToKind.has(c.read_nonce) || seenKinds.has(c.kind)) {
      throw new Error('PERMISSION_NATIVE_AUTHORITY_CUT_INVALID');
    }
    nonceToKind.set(c.read_nonce, c.kind);
    seenKinds.add(c.kind);
  }
  if (!seenKinds.has('sql') || !seenKinds.has('im')) {
    throw new Error('PERMISSION_NATIVE_AUTHORITY_CUT_INVALID');
  }
  return nonceToKind;
}

function verifyAuthorityRefs(rawRefs: unknown, authoritiesByNonce: ReadonlyMap<string, 'sql' | 'im'>): void {
  if (!Array.isArray(rawRefs) || rawRefs.length < 2) {
    throw new Error('PERMISSION_NATIVE_AUTHORITY_REFS_INVALID');
  }
  const seenKinds = new Set<'sql' | 'im'>();
  for (const ref of rawRefs) {
    if (typeof ref !== 'string') throw new Error('PERMISSION_NATIVE_AUTHORITY_REFS_INVALID');
    const kind = authoritiesByNonce.get(ref);
    if (!kind) throw new Error('PERMISSION_NATIVE_AUTHORITY_REFS_INVALID');
    seenKinds.add(kind);
  }
  if (!seenKinds.has('sql') || !seenKinds.has('im')) {
    throw new Error('PERMISSION_NATIVE_AUTHORITY_REFS_INVALID');
  }
}

function verifyNativeEnvelope(
  data: Record<string, unknown>,
  expectedKey: Readonly<PermissionKey>,
  expectedRequestId: string,
  payloadField: 'binding' | 'results' | 'page',
): { readonly reply: Record<string, unknown>; readonly authoritiesByNonce: ReadonlyMap<string, 'sql' | 'im'> } {
  const reply = object(data, [
    'schema_version',
    'profile_version',
    'key',
    'request_id',
    'read_id',
    'observed_at',
    'authorities',
    payloadField,
  ]);
  if (reply.schema_version !== 1
    || reply.profile_version !== 1
    || reply.request_id !== expectedRequestId
    || typeof reply.read_id !== 'string' || !/^[0-9a-f]{32}$/.test(reply.read_id)
    || typeof reply.observed_at !== 'string' || Number.isNaN(Date.parse(reply.observed_at))) {
    throw new Error('PERMISSION_NATIVE_ENVELOPE_MISMATCH');
  }
  const keyObj = object(reply.key, ['origin', 'bot_uid', 'space_id']);
  if (keyObj.origin !== expectedKey.origin
    || keyObj.bot_uid !== expectedKey.bot_uid
    || keyObj.space_id !== expectedKey.space_id) {
    throw new Error('PERMISSION_NATIVE_ENVELOPE_KEY_MISMATCH');
  }
  const authoritiesByNonce = verifyNativeAuthorities(reply.authorities);
  return { reply, authoritiesByNonce };
}

const REQUIRED_COMMON_RESOLVE_PREDICATES = [
  'identity_supported',
  'author_is_human',
  'author_active',
  'author_not_destroyed',
  'bot_user_active',
  'bot_robot_active',
  'bot_creator_eligible',
  'space_active',
  'caller_space_member',
  'bot_space_member',
  'message_source_exact',
  'message_space_exact',
  'message_author_exact',
  'message_recipient_exact',
  'message_version_exact',
  'source_exists',
] as const;

function verifyResolvedPredicates(
  rawPredicates: unknown,
  purpose: 'admit' | 'reply',
  sourceKind: NativeHeader['source']['kind'],
): boolean {
  if (!rawPredicates || typeof rawPredicates !== 'object' || Array.isArray(rawPredicates)) {
    return false;
  }
  const preds = rawPredicates as Record<string, unknown>;
  const entries = Object.entries(preds);
  if (entries.length === 0) return false;
  for (const [, val] of entries) {
    if (typeof val !== 'boolean' || val !== true) return false;
  }
  for (const reqKey of REQUIRED_COMMON_RESOLVE_PREDICATES) {
    if (preds[reqKey] !== true) return false;
  }
  if (purpose === 'reply') {
    if (preds.bot_current_send !== true) return false;
    if (sourceKind === 'dm') {
      return preds.dm_peer_exact === true
        && preds.dm_human_blocks_bot_clear === true
        && preds.dm_bot_blocks_human_clear === true
        && preds.dm_bot_to_human_send_relation === true;
    }
    if (sourceKind === 'group') {
      return preds.group_space_exact === true
        && preds.bot_group_active_member === true
        && preds.bot_external_access === true;
    }
    if (sourceKind === 'thread') {
      return preds.parent_verified === true
        && preds.thread_not_deleted === true
        && preds.parent_space_exact === true
        && preds.bot_parent_active_member === true
        && preds.bot_external_access === true;
    }
    return false;
  }
  // purpose === 'admit'
  if (preds.caller_current_read !== true
    || preds.bot_current_read !== true
    || preds.caller_original_visible !== true
    || preds.bot_original_visible !== true) {
    return false;
  }
  if (sourceKind === 'dm') {
    return preds.dm_peer_exact === true
      && preds.dm_human_blocks_bot_clear === true
      && preds.dm_bot_blocks_human_clear === true
      && preds.dm_human_to_bot_relation === true
      && preds.dm_bot_to_human_read_relation === true;
  }
  if (sourceKind === 'group') {
    return preds.group_space_exact === true
      && preds.caller_group_active_member === true
      && preds.bot_group_active_member === true
      && preds.caller_external_access === true
      && preds.bot_external_access === true;
  }
  if (sourceKind === 'thread') {
    return preds.parent_verified === true
      && preds.thread_not_deleted === true
      && preds.parent_space_exact === true
      && preds.caller_parent_active_member === true
      && preds.bot_parent_active_member === true
      && preds.caller_parent_current_read === true
      && preds.bot_parent_current_read === true
      && preds.caller_external_access === true
      && preds.bot_external_access === true;
  }
  return false;
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

interface BoundDeliveryRecord {
  readonly deliveryReference: string;
  readonly header: Readonly<NativeHeader>;
  readonly message: Readonly<BotMessage>;
  readonly payloadSha256: string;
  readonly proven: Readonly<Record<string, boolean>>;
  readonly unknown: readonly string[];
  readonly resolvablePurposes: readonly string[];
}

export function createNativeEndpointDriver(options: NativeEndpointDriverOptions): NativeEndpointDriver {
  const expectedKey = Object.freeze({ ...options.key });
  const router = options.router ?? new SessionRouter(options.config, options.botId, options.ownerUid ?? '');
  const fetchFn = options.fetchImpl ?? fetch;
  const apiUrl = options.config.apiUrl.replace(/\/+$/, '');
  const botToken = options.config.botToken;
  const boundDeliveryByHeaderRef = new Map<string, BoundDeliveryRecord>();

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
      if (options.syntheticRecoveryFence) {
        const rf = options.syntheticRecoveryFence;
        if (typeof rf.sql_incarnation !== 'string' || !/^[0-9a-f]{32}$/.test(rf.sql_incarnation)
          || typeof rf.im_incarnation !== 'string' || !/^[0-9a-f]{32}$/.test(rf.im_incarnation)
          || rf.ack_before_read_start !== true) {
          throw new Error('PERMISSION_NATIVE_AND_CONTAINMENT_BINDINGS_UNAVAILABLE: invalid syntheticRecoveryFence');
        }
        return;
      }
      // Production octo-server v7 mounts only /v1/bot/permission-facts/v1 and
      // /v1/bot/permission-facts/v1/bind-delivery (no /fence route, and ordinary
      // SQL recovery cutover in XIN-2830 Decision 1 remains awaiting Owner decision).
      throw new Error(
        'PERMISSION_NATIVE_AND_CONTAINMENT_BINDINGS_UNAVAILABLE: PERMISSION_NATIVE_RECOVERY_FENCE_UNAVAILABLE ' +
        '(octo-server v7 mounts no recovery fence route; awaiting Owner decision on XIN-2830 Decision 1)',
      );
    },

    async inspect(delivery: ReceivedDelivery): Promise<NativeIngress> {
      if (delivery.recipientUid !== expectedKey.bot_uid) {
        throw new Error('Native delivery recipient mismatch');
      }
      if (typeof delivery.message.channel_type !== 'number'
        || typeof delivery.message.channel_id !== 'string' || !delivery.message.channel_id
        || typeof delivery.message.message_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(delivery.message.message_id)
        || typeof delivery.message.from_uid !== 'string' || !delivery.message.from_uid
        || !Number.isSafeInteger(delivery.message.message_seq) || delivery.message.message_seq <= 0) {
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
      const { reply, authoritiesByNonce } = verifyNativeEnvelope(data, expectedKey, requestId, 'binding');
      const binding = object(reply.binding);
      verifyAuthorityRefs(binding.authority_refs, authoritiesByNonce);
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
      const rawProven = object(binding.proven_predicates);
      const proven: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(rawProven)) {
        if (typeof v !== 'boolean') throw new Error('Native delivery proven_predicates invalid');
        proven[k] = v;
      }
      const unknown = Array.isArray(binding.unknown_predicates) ? binding.unknown_predicates.map(String) : [];
      const resolvablePurposes = Array.isArray(binding.resolvable_purposes) ? binding.resolvable_purposes.map(String) : [];
      if (proven.message_source_exact !== true
        || proven.message_author_exact !== true
        || proven.message_recipient_exact !== true
        || proven.message_version_exact !== true
        || proven.message_space_exact !== true
        || proven.bot_current_read !== true
        || proven.caller_current_read !== true
        || unknown.includes('message_space_exact')) {
        throw new Error('Native delivery required predicates unproven');
      }
      if (delivery.message.channel_type !== ChannelType.DM
        && (proven.bot_parent_current_read !== true || proven.caller_parent_current_read !== true)) {
        throw new Error('Native delivery required parent predicates unproven');
      }
      const rawHeader = object(binding.header);
      if (rawHeader.header_reference !== headerReference
        || rawHeader.native_message_version !== nativeMessageVersion
        || rawHeader.payload_sha256 !== delivery.payloadSha256
        || rawHeader.space_id !== expectedKey.space_id
        || rawHeader.recipient_bot_uid !== expectedKey.bot_uid) {
        throw new Error('Native bound header mismatch');
      }
      if (boundDeliveryByHeaderRef.size >= 4096) {
        const oldest = boundDeliveryByHeaderRef.keys().next().value;
        if (oldest !== undefined) {
          boundDeliveryByHeaderRef.delete(oldest);
        }
      }
      const typedHeader = rawHeader as unknown as Readonly<NativeHeader>;
      boundDeliveryByHeaderRef.set(headerReference, Object.freeze({
        deliveryReference,
        header: typedHeader,
        message: delivery.message,
        payloadSha256: delivery.payloadSha256,
        proven: Object.freeze(proven),
        unknown: Object.freeze(unknown),
        resolvablePurposes: Object.freeze(resolvablePurposes),
      }));
      return {
        deliveryReference,
        header: typedHeader,
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
        const bound = boundDeliveryByHeaderRef.get(original.headerReference);
        if (!bound) return 'unknown';
        const effectiveSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        const requestId = randomBytes(16).toString('hex');
        const data = await callNativeEndpoint(
          NATIVE_FACTS_PATH,
          {
            schema_version: 1,
            profile_version: 1,
            request_id: requestId,
            operation: 'resolve',
            purpose: 'admit',
            references: [{ delivery_reference: bound.deliveryReference }],
          },
          effectiveSignal,
        );
        const { reply, authoritiesByNonce } = verifyNativeEnvelope(data, expectedKey, requestId, 'results');
        if (!Array.isArray(reply.results) || reply.results.length !== 1) return 'unknown';
        const result = object(reply.results[0]);
        const resolvedRef = typeof result.reference === 'string' ? result.reference : result.delivery_reference;
        if (resolvedRef !== bound.deliveryReference) return 'unknown';
        if (result.status === 'unavailable') {
          if (result.reason === 'expired_reference'
            || result.reason === 'visibility_denied'
            || result.reason === 'version_mismatch'
            || result.reason === 'identity_mismatch') {
            return 'deny';
          }
          return 'unknown';
        }
        if (result.status !== 'resolved') return 'unknown';
        verifyAuthorityRefs(result.authority_refs, authoritiesByNonce);
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
        sameHeaderIdentity(disclosedHeader, header, expectedKey);
        if (!verifyResolvedPredicates(result.predicates, 'admit', header.source.kind)) {
          return 'deny';
        }
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
      const bound = boundDeliveryByHeaderRef.get(binding.header.header_reference);
      if (!bound) {
        throw new Error('PERMISSION_NATIVE_FACT_SOURCE_UNAVAILABLE: unbound header_reference');
      }
      sameHeaderIdentity(bound.header as unknown as Record<string, unknown>, binding.header, expectedKey);
      if (bound.payloadSha256 !== binding.header.payload_sha256
        || bound.message.message_id !== binding.header.message_id
        || bound.message.from_uid !== binding.header.author_uid
        || bound.message.channel_id !== binding.header.source.id
        || ({ dm: ChannelType.DM, group: ChannelType.Group, thread: ChannelType.CommunityTopic })[binding.header.source.kind] !== bound.message.channel_type) {
        throw new Error('PERMISSION_NATIVE_HEADER_MISMATCH: delivered frame does not match bound header');
      }
      if (bound.unknown.includes('bot_original_visible')
        || bound.unknown.includes('caller_original_visible')
        || bound.proven.bot_original_visible !== true
        || bound.proven.caller_original_visible !== true) {
        throw new Error('PERMISSION_NATIVE_ORIGINAL_VISIBILITY_UNKNOWN: bind_delivery did not prove original visibility');
      }
      const rawPayload = bound.message.payload as unknown as Record<string, unknown>;
      if (rawPayload.reply !== undefined || rawPayload.quote !== undefined || rawPayload.forward !== undefined) {
        throw new Error('PERMISSION_NATIVE_EMBEDDED_REFERENCE_UNRESOLVED: delivered frame contains unresolved embedded reference');
      }
      const effectiveSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      const requestId = randomBytes(16).toString('hex');
      const contextEpoch = typeof binding.contextEpoch === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(binding.contextEpoch)
        ? binding.contextEpoch
        : '0';
      const requestedHeaders = [
        { header_reference: binding.header.header_reference },
        ...(binding.contributors ?? [])
          .filter(c => c.header_reference !== binding.header.header_reference)
          .map(c => ({ header_reference: c.header_reference })),
      ];
      const data = await callNativeEndpoint(
        NATIVE_FACTS_PATH,
        {
          schema_version: 1,
          profile_version: 1,
          request_id: requestId,
          operation: 'history_disclosure',
          context_id: binding.contextId,
          context_epoch: contextEpoch,
          headers: requestedHeaders,
        },
        effectiveSignal,
      );
      const { reply, authoritiesByNonce } = verifyNativeEnvelope(data, expectedKey, requestId, 'results');
      if (!Array.isArray(reply.results) || reply.results.length !== requestedHeaders.length) {
        throw new Error('Native history_disclosure results invalid');
      }
      const primary = object(reply.results[0]);
      const primaryRef = typeof primary.reference === 'string' ? primary.reference : primary.header_reference;
      if (primaryRef !== binding.header.header_reference) {
        throw new Error('Native history_disclosure header_reference mismatch');
      }
      if (primary.status !== 'resolved') {
        throw new Error(`PERMISSION_NATIVE_ORIGINAL_VISIBILITY_UNKNOWN: status=${String(primary.status)} reason=${String(primary.reason ?? 'unknown')}`);
      }
      verifyAuthorityRefs(primary.authority_refs, authoritiesByNonce);
      if (primary.header_reference !== binding.header.header_reference
        || primary.context_id !== binding.contextId
        || primary.context_epoch !== contextEpoch
        || primary.payload_sha256 !== binding.header.payload_sha256
        || typeof primary.permit !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(primary.permit)) {
        throw new Error('Native history_disclosure permit binding mismatch');
      }
      if (reply.results.length > 1 || requestedHeaders.length > 1) {
        // octo-server history_disclosure issues metadata-only permits (#/$defs/Token)
        // and does not mount an HTTP body consumer route for historical contributors.
        // A metadata-only disclosure permit is NOT body content; fail closed.
        throw new Error('PERMISSION_NATIVE_HISTORY_BODY_CONSUMER_UNAVAILABLE: metadata-only disclosure permit is not body content');
      }
      const extractedInput = typeof bound.message.payload?.content === 'string' ? bound.message.payload.content : '';
      if (!extractedInput) {
        throw new Error('Native delivered frame content unavailable');
      }
      return {
        input: extractedInput,
        originals: [binding.header],
      };
    },

    async publish(binding: Readonly<EndpointBinding>, outputText: string, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (typeof outputText !== 'string' || !outputText.trim()) {
        throw new Error('Publication text unavailable');
      }
      const bound = boundDeliveryByHeaderRef.get(binding.header.header_reference);
      const deliveryReference = bound?.deliveryReference;
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
      const { reply, authoritiesByNonce } = verifyNativeEnvelope(check, expectedKey, requestId, 'results');
      if (!Array.isArray(reply.results) || reply.results.length !== 1) {
        throw new Error('Native reply resolve results invalid');
      }
      const resolved = object(reply.results[0]);
      const resolvedRef = typeof resolved.reference === 'string' ? resolved.reference : resolved.delivery_reference;
      if (resolvedRef !== deliveryReference || resolved.status !== 'resolved') {
        throw new Error('Native reply route denied');
      }
      verifyAuthorityRefs(resolved.authority_refs, authoritiesByNonce);
      sameHeaderIdentity(object(resolved.header), binding.header, expectedKey);
      if (!verifyResolvedPredicates(resolved.predicates, 'reply', binding.header.source.kind)) {
        throw new Error('Native reply route denied: required reply predicate false');
      }
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
      const { reply, authoritiesByNonce } = verifyNativeEnvelope(check, expectedKey, requestId, 'results');
      if (!Array.isArray(reply.results) || reply.results.length !== 1) return;
      const resolved = object(reply.results[0]);
      const resolvedRef = typeof resolved.reference === 'string' ? resolved.reference : resolved.delivery_reference;
      if (resolvedRef !== ingress.deliveryReference || resolved.status !== 'resolved') return;
      verifyAuthorityRefs(resolved.authority_refs, authoritiesByNonce);
      sameHeaderIdentity(object(resolved.header), ingress.header, expectedKey);
      if (!verifyResolvedPredicates(resolved.predicates, 'reply', ingress.header.source.kind)) return;
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
      let relayBridge: TurnRelayBridge | undefined;
      let sessionBound = Boolean(binding.verifiedResume?.workdir);
      let answer = '';
      try {
        relayBridge = await startTurnRelayBridge(effectiveLaunch, { signal });
        const bridgedLaunch = relayBridge.launch;
        for await (const event of runQuery(input, options.config, undefined, undefined, {
          privateWorker: bridgedLaunch,
          signal,
          resume: binding.verifiedResume?.sessionId,
          onManagedExecution: execution => {
            activeExecutions.add(execution);
            turnExecutions.push(execution);
          },
          onSessionId: sessionId => {
            binding.bindSession?.(sessionId, {
              workdir: bridgedLaunch.workdir,
              codexHome: bridgedLaunch.codexHome,
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
          if (!exited) {
            await relayBridge?.close();
            throw new Error('Contained worker execution did not stop within grace period');
          }
        }
        await relayBridge?.close();
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

const MAX_RELAY_RESPONSE_BUDGET_BYTES = 64 * 1024 * 1024;

function validRelayMaxResponseBytes(value: unknown): value is number | string {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 && value <= MAX_RELAY_RESPONSE_BUDGET_BYTES;
  }
  if (typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_RELAY_RESPONSE_BUDGET_BYTES;
  }
  return false;
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
    const allowedTicketKeys = ['ca_file', 'ca_sha256', 'cert_sha256', 'endpoint', 'max_response_bytes', 'peer_sha256', 'server_name', 'token'];
    const presentTicketKeys = Object.keys(rawTicket);
    if (!Object.hasOwn(rawTicket, 'endpoint') || !Object.hasOwn(rawTicket, 'token')
      || presentTicketKeys.some(k => !allowedTicketKeys.includes(k))
      || (Object.hasOwn(rawTicket, 'max_response_bytes') && !validRelayMaxResponseBytes(rawTicket.max_response_bytes))) {
      throw new Error('Relay ticket invalid');
    }
    // The producer uses Go json.Marshal(map[string]any) for this ticket
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
  const configuredCaFile = typeof boot.hostConfig.relay_ca === 'string' && boot.hostConfig.relay_ca
    ? boot.hostConfig.relay_ca
    : typeof boot.hostConfig.peer_ca === 'string' && boot.hostConfig.peer_ca
      ? boot.hostConfig.peer_ca
      : undefined;
  const configuredCaSha = typeof boot.hostConfig.relay_ca_sha256 === 'string' && boot.hostConfig.relay_ca_sha256
    ? boot.hostConfig.relay_ca_sha256
    : undefined;
  if (configuredCaSha !== undefined && !/^[0-9a-f]{64}$/.test(configuredCaSha)) {
    throw new Error('Relay TLS trust invalid');
  }
  const configuredPeerPin = typeof boot.hostConfig.relay_cert_sha256 === 'string' && boot.hostConfig.relay_cert_sha256
    ? boot.hostConfig.relay_cert_sha256
    : typeof boot.hostConfig.relay_peer_sha256 === 'string' && boot.hostConfig.relay_peer_sha256
      ? boot.hostConfig.relay_peer_sha256
      : undefined;
  if (configuredPeerPin !== undefined && !/^[0-9a-f]{64}$/.test(configuredPeerPin)) {
    throw new Error('Relay TLS trust invalid');
  }
  const configuredServerName = typeof boot.hostConfig.relay_server_name === 'string' && boot.hostConfig.relay_server_name
    ? boot.hostConfig.relay_server_name
    : undefined;
  if (configuredServerName !== undefined && !validRelayServerName(configuredServerName)) {
    throw new Error('Relay TLS trust invalid');
  }
  const caBytesToCheck = replyTls?.ca_pem
    ? Buffer.from(replyTls.ca_pem, 'utf8')
    : replyTls?.ca_file && existsSync(replyTls.ca_file)
      ? readFileSync(replyTls.ca_file)
      : fallbackCaBytes;
  if (configuredCaSha !== undefined) {
    if (!caBytesToCheck || createHash('sha256').update(caBytesToCheck).digest('hex') !== configuredCaSha) {
      throw new Error('Relay TLS CA digest conflict');
    }
  }
  if (hasHttpPin) {
    const caSha = text(relay.ca_sha256);
    const peerSha = text(relay.peer_sha256);
    if (!/^[0-9a-f]{64}$/.test(caSha) || !/^[0-9a-f]{64}$/.test(peerSha)) {
      throw new Error('Relay binding conflict');
    }
    if (configuredCaSha && caSha !== configuredCaSha) {
      throw new Error('Relay TLS CA digest conflict');
    }
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
    if (caBytesToCheck && createHash('sha256').update(caBytesToCheck).digest('hex') !== caSha) {
      throw new Error('Relay TLS CA digest conflict');
    }
  }
  const effectiveCaSha = hasHttpPin ? text(relay.ca_sha256) : (replyTls?.ca_sha256 ?? configuredCaSha);
  const effectivePeerSha = hasHttpPin
    ? text(relay.peer_sha256)
    : (replyTls?.cert_sha256 ?? replyTls?.peer_sha256 ?? configuredPeerPin);
  let effectiveHttpTls: Readonly<TurnRelayTrust> | undefined = replyTls;
  if (!effectiveHttpTls && (configuredCaSha || configuredPeerPin || (typeof boot.hostConfig.relay_ca === 'string' && boot.hostConfig.relay_ca) || configuredServerName)) {
    const rawFallbackTls: Record<string, unknown> = {
      ...(configuredCaFile ? { ca_file: configuredCaFile } : {}),
      ...(configuredCaSha ? { ca_sha256: configuredCaSha } : {}),
      ...(typeof boot.hostConfig.relay_peer_sha256 === 'string' && boot.hostConfig.relay_peer_sha256 ? { peer_sha256: boot.hostConfig.relay_peer_sha256 } : {}),
      ...(typeof boot.hostConfig.relay_cert_sha256 === 'string' && boot.hostConfig.relay_cert_sha256 ? { cert_sha256: boot.hostConfig.relay_cert_sha256 } : {}),
      ...(configuredServerName ? { server_name: configuredServerName } : {}),
    };
    effectiveHttpTls = checkTurnRelayTrust(rawFallbackTls, boot.hostConfig, fallbackCaBytes);
  } else if (effectiveHttpTls && (configuredCaSha || configuredPeerPin || configuredServerName || configuredCaFile)) {
    effectiveHttpTls = Object.freeze({
      ...(configuredCaFile && !effectiveHttpTls.ca_file ? { ca_file: configuredCaFile } : {}),
      ...effectiveHttpTls,
      ...(configuredCaSha && !effectiveHttpTls.ca_sha256 ? { ca_sha256: configuredCaSha } : {}),
      ...(configuredPeerPin && !effectiveHttpTls.cert_sha256 && !effectiveHttpTls.peer_sha256 ? { cert_sha256: configuredPeerPin, peer_sha256: configuredPeerPin } : {}),
      ...(configuredServerName && !effectiveHttpTls.server_name ? { server_name: configuredServerName } : {}),
    });
  }
  const url = new URL(text(relay.url));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Relay URL invalid');
  return {
    transport,
    url: text(relay.url),
    handle: text(relay.handle),
    ...(effectiveHttpTls ? { tls: effectiveHttpTls } : {}),
    ...(effectiveCaSha ? { caSha256: effectiveCaSha } : {}),
    ...(effectivePeerSha ? { peerSha256: effectivePeerSha } : {}),
  };
}

/** Per-bot opt-in. Presence selects managed mode before any legacy data loads;
 * unreadable/invalid/stale descriptors fail startup, never downgrade. */
export function managedPermissionFactory(config: Config, dependencies?: Partial<Dependencies>): ManagedPermissionFactory | undefined {
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
    const activeDependencies: Dependencies = {
      native: dependencies?.native ?? createNativeEndpointDriver({
        config: current,
        key: descriptor.key,
        botId,
      }),
      worker: dependencies?.worker ?? createContainedWorkerDriver({
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
