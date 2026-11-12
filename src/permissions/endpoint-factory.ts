import { lstatSync } from 'node:fs';
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
import { createIsolatingWorkerLauncher, preparePrivateWorker, validRelayServerName, type PrivateWorkerLaunch, type TurnRelay, type TurnRelayTrust } from './worker-launch.js';
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

function channelTypeForSource(kind: NativeHeader['source']['kind']): ChannelType {
  if (kind === 'dm') return ChannelType.DM;
  if (kind === 'group') return ChannelType.Group;
  if (kind === 'thread') return ChannelType.CommunityTopic;
  throw new Error('Native source kind unavailable');
}

export function createNativeEndpointDriver(options: NativeEndpointDriverOptions): NativeEndpointDriver {
  const expectedKey = Object.freeze({ ...options.key });
  const router = options.router ?? new SessionRouter(options.config, options.botId, options.ownerUid ?? '');
  const fetchFn = options.fetchImpl ?? fetch;
  const apiUrl = options.config.apiUrl.replace(/\/+$/, '');
  const botToken = options.config.botToken;

  async function callNativeFacts(
    payload: Record<string, unknown>,
    signal: AbortSignal,
    failureCode = 'PERMISSION_NATIVE_FACT_SOURCE_UNAVAILABLE',
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchFn(`${apiUrl}${NATIVE_FACTS_PATH}`, {
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
      const data = await callNativeFacts(
        { op: 'recover_fence', key: expectedKey },
        AbortSignal.timeout(5000),
        'PERMISSION_NATIVE_AND_CONTAINMENT_BINDINGS_UNAVAILABLE',
      );
      const reply = object(data, ['ok', 'key', 'fence_through_v1']);
      const rKey = object(reply.key, ['origin', 'bot_uid', 'space_id']);
      const fence = object(reply.fence_through_v1, ['stream_id', 'stream_incarnation', 'sequence']);
      if (reply.ok !== true
        || rKey.origin !== expectedKey.origin
        || rKey.bot_uid !== expectedKey.bot_uid
        || rKey.space_id !== expectedKey.space_id
        || typeof fence.stream_id !== 'string' || !fence.stream_id
        || typeof fence.stream_incarnation !== 'string' || !/^[0-9a-f]{32}$/.test(fence.stream_incarnation)
        || typeof fence.sequence !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(fence.sequence)) {
        throw new Error('PERMISSION_NATIVE_AND_CONTAINMENT_BINDINGS_UNAVAILABLE: invalid recovery fence');
      }
    },

    async inspect(delivery: ReceivedDelivery): Promise<NativeIngress> {
      if (delivery.recipientUid !== expectedKey.bot_uid) {
        throw new Error('Native delivery recipient mismatch');
      }
      // Resolve delivery metadata through octo-server using existing WKSocket
      // transport identifiers; requires no octo-im/WukongIM wire extension.
      const data = await callNativeFacts({
        op: 'inspect_delivery',
        key: expectedKey,
        recipient_uid: delivery.recipientUid,
        message_id: delivery.message.message_id,
        message_seq: delivery.message.message_seq,
        from_uid: delivery.message.from_uid,
        channel_id: delivery.message.channel_id ?? null,
        channel_type: delivery.message.channel_type ?? null,
        timestamp: delivery.message.timestamp ?? null,
        payload_sha256: delivery.payloadSha256,
      }, AbortSignal.timeout(5000));
      const reply = object(data, ['deliveryReference', 'header']);
      if (typeof reply.deliveryReference !== 'string' || !reply.deliveryReference) {
        throw new Error('Native delivery reference unavailable');
      }
      return {
        deliveryReference: reply.deliveryReference,
        header: reply.header as NativeHeader,
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
        const data = await callNativeFacts({
          op: 'revalidate_original',
          key: expectedKey,
          original,
          header,
        }, effectiveSignal);
        const reply = object(data, ['verdict']);
        if (reply.verdict === 'allow' || reply.verdict === 'deny') return reply.verdict;
        return 'unknown';
      } catch {
        return 'unknown';
      }
    },

    async prepareInput(binding: Readonly<EndpointBinding>, signal: AbortSignal): Promise<{
      input: string;
      originals: readonly Readonly<NativeHeader>[];
      contributorReferences?: readonly string[];
    }> {
      const effectiveSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      const data = await callNativeFacts({
        op: 'prepare_disclosure',
        key: expectedKey,
        capsule_id: binding.capsuleId,
        turn_id: binding.turnId,
        generation: binding.generation,
        header_reference: binding.header.header_reference,
      }, effectiveSignal);
      const hasContribRefs = Object.hasOwn(data, 'contributor_references');
      const hasDeliveryRefs = Object.hasOwn(data, 'delivery_references');
      const reply = object(
        data,
        hasContribRefs
          ? ['input', 'originals', 'contributor_references']
          : hasDeliveryRefs
            ? ['input', 'originals', 'delivery_references']
            : ['input', 'originals'],
      );
      if (typeof reply.input !== 'string' || !Array.isArray(reply.originals)) {
        throw new Error('Native disclosure payload invalid');
      }
      const rawRefs = hasContribRefs ? reply.contributor_references : hasDeliveryRefs ? reply.delivery_references : undefined;
      if (rawRefs !== undefined && (!Array.isArray(rawRefs) || rawRefs.some(r => typeof r !== 'string' || !r))) {
        throw new Error('Native disclosure contributor references invalid');
      }
      return {
        input: reply.input,
        originals: reply.originals as readonly Readonly<NativeHeader>[],
        ...(rawRefs && rawRefs.length > 0 ? { contributorReferences: rawRefs as readonly string[] } : {}),
      };
    },

    async publish(binding: Readonly<EndpointBinding>, outputText: string, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (typeof outputText !== 'string' || !outputText.trim()) {
        throw new Error('Publication text unavailable');
      }
      const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      const check = await callNativeFacts({
        op: 'check_reply_route',
        key: expectedKey,
        capsule_id: binding.capsuleId,
        turn_id: binding.turnId,
        generation: binding.generation,
        header: binding.header,
      }, checkSignal);
      const verdict = object(check, ['allow']);
      if (verdict.allow !== true) {
        throw new Error('Native reply route denied');
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
      record: Readonly<RefusalRecord>,
      refusalText: string,
      signal: AbortSignal,
    ): Promise<void> {
      const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
      const check = await callNativeFacts({
        op: 'check_refusal_route',
        key: expectedKey,
        delivery_reference: ingress.deliveryReference,
        header: ingress.header,
        correlation: record.correlation,
        category: record.category,
      }, boundedSignal);
      const verdict = object(check, ['allow']);
      if (verdict.allow !== true) return;
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
      let answer = '';
      try {
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

function checkTurnRelayTrust(
  rawTls: unknown,
  hostConfig: Readonly<Record<string, unknown>>,
): Readonly<TurnRelayTrust> {
  const obj = object(rawTls);
  const allowed = new Set(['ca_file', 'cert_sha256', 'server_name']);
  const keys = Object.keys(obj);
  if (keys.length === 0 || keys.some(k => !allowed.has(k))) {
    throw new Error('Relay TLS trust invalid');
  }
  const out: { ca_file?: string; cert_sha256?: string; server_name?: string } = {};
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
    out.ca_file = caFile;
  }
  if (Object.hasOwn(obj, 'cert_sha256')) {
    const certSha = text(obj.cert_sha256);
    if (!/^[0-9a-f]{64}$/.test(certSha)) throw new Error('Relay TLS trust invalid');
    if (typeof hostConfig.relay_cert_sha256 === 'string' && hostConfig.relay_cert_sha256 && certSha !== hostConfig.relay_cert_sha256) {
      throw new Error('Relay TLS certificate pin conflict');
    }
    out.cert_sha256 = certSha;
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
export function checkedTurnRelay(value: Readonly<Record<string, unknown>>, boot: Pick<CoordinatorBoot,
  'executable' | 'executableSha256' | 'hostConfig'>, transport: 'http' | 'stdio'): TurnRelay {
  if (value.transport !== transport) throw new Error('Relay transport conflict');
  const hasTls = Object.hasOwn(value, 'tls');
  const replyTls = hasTls ? checkTurnRelayTrust(value.tls, boot.hostConfig) : undefined;
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
    const allowedTicketKeys = ['ca_file', 'cert_sha256', 'endpoint', 'server_name', 'token'];
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
    const ticketTrustKeys = ['ca_file', 'cert_sha256', 'server_name'].filter(k => Object.hasOwn(rawTicket, k));
    let ticketTls: Readonly<TurnRelayTrust> | undefined;
    if (ticketTrustKeys.length > 0) {
      const rawTrust: Record<string, unknown> = {};
      for (const k of ticketTrustKeys) rawTrust[k] = rawTicket[k];
      ticketTls = checkTurnRelayTrust(rawTrust, boot.hostConfig);
    }
    if (replyTls && ticketTls) {
      if (replyTls.ca_file !== ticketTls.ca_file
        || replyTls.cert_sha256 !== ticketTls.cert_sha256
        || replyTls.server_name !== ticketTls.server_name) {
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
  if (hasHttpPin && (!/^[0-9a-f]{64}$/.test(text(relay.ca_sha256)) || !/^[0-9a-f]{64}$/.test(text(relay.peer_sha256)))) {
    throw new Error('Relay binding conflict');
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
