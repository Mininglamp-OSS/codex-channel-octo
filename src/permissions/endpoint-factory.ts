import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { DbAdapter } from '../db-adapter.js';
import { EndpointPermissionHost, type EndpointHostPorts, type PermissionEndpoint, type PermissionKey } from './endpoint-host.js';
import { decodeControl, object, type ControlConnection } from './control-client.js';
import { startPermissionCoordinator, type CoordinatorBoot } from './coordinator-process.js';
import { privateFile, verifyExecutable } from './private-files.js';
import { ReplayJournal } from './replay-journal.js';
import { preparePrivateWorker, type PrivateWorkerLaunch, type TurnRelay } from './worker-launch.js';

/** Compiled trusted adapters, never imported from an operator/module path, MCP,
 * model output or a JSON claim. No actual native/containment producer is shipped
 * by the pinned server/CLI contracts. Tests supply synthetic adapters explicitly. */
export interface NativeEndpointDriver extends Pick<EndpointHostPorts,
  'inspect' | 'candidate' | 'prepareInput' | 'publish' | 'refuse' | 'stop'> {
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

interface Descriptor {
  key: Readonly<PermissionKey>;
  recipientId: string;
  transport: 'http' | 'stdio';
  boot: Omit<CoordinatorBoot, 'botToken' | 'origin' | 'botUid' | 'recipientId'>;
  journalKey: Buffer;
  journalKeyVersion: string;
  provision: boolean;
  worker: { root: string; launcher: string; launcherSha256: string; instructions: string;
    provider?: { baseUrl: string; apiKey?: string } };
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Managed descriptor invalid');
  return value;
}

function readDescriptor(path: string): Descriptor {
  const d = object(decodeControl(privateFile(path, 16384)), ['version', 'key', 'recipient_id', 'transport',
    'coordinator', 'tls', 'journal', 'worker']);
  if (d.version !== 1 || !['stdio', 'http'].includes(String(d.transport))) throw new Error('Managed descriptor invalid');
  const key = object(d.key, ['origin', 'bot_uid', 'space_id']);
  const permissionKey = Object.freeze({ origin: text(key.origin), bot_uid: text(key.bot_uid), space_id: text(key.space_id) });
  const coordinator = object(d.coordinator, ['root', 'executable', 'sha256', 'host_config']);
  const hostConfig = object(decodeControl(privateFile(text(coordinator.host_config), 16384)));
  const tls = object(d.tls, ['host', 'port', 'servername', 'ca', 'cert', 'key', 'peer_sha256']);
  if (!Number.isInteger(tls.port) || Number(tls.port) < 1 || Number(tls.port) > 65535) throw new Error('Managed descriptor invalid');
  const connection: Omit<ControlConnection, 'configuredOrigin' | 'recipientId' | 'endpointIncarnation' | 'coordinatorIncarnation'> = {
    host: text(tls.host), port: Number(tls.port), servername: text(tls.servername), peerCertificateSha256: text(tls.peer_sha256),
    ca: privateFile(text(tls.ca), 65536), cert: privateFile(text(tls.cert), 65536), key: privateFile(text(tls.key), 65536),
  };
  const journal = object(d.journal, ['key', 'key_version', 'provision']);
  if (typeof journal.provision !== 'boolean') throw new Error('Managed descriptor invalid');
  const worker = object(d.worker, ['root', 'launcher', 'sha256', 'instructions', 'provider']);
  let provider: Descriptor['worker']['provider'];
  if (worker.provider !== null) {
    const p = object(worker.provider, ['base_url', 'api_key_file']);
    provider = { baseUrl: text(p.base_url) };
    if (p.api_key_file !== null) provider.apiKey = privateFile(text(p.api_key_file), 16384).toString('utf8').trim();
  }
  return { key: permissionKey, recipientId: text(d.recipient_id), transport: d.transport as Descriptor['transport'],
    boot: { root: text(coordinator.root), executable: text(coordinator.executable), executableSha256: text(coordinator.sha256),
      hostConfig, tls: connection }, journalKey: privateFile(text(journal.key), 32), journalKeyVersion: text(journal.key_version),
    provision: journal.provision, worker: { root: text(worker.root), launcher: text(worker.launcher),
      launcherSha256: text(worker.sha256), instructions: text(worker.instructions), ...(provider ? { provider } : {}) } };
}

/** Exact closed relay reply. Pin the stdio executable to the selected CLI, not
 * merely to a digest supplied by another reply field. HTTP stays HTTPS. */
export function checkedTurnRelay(value: Readonly<Record<string, unknown>>, boot: Pick<CoordinatorBoot,
  'executable' | 'executableSha256' | 'hostConfig'>, transport: 'http' | 'stdio'): TurnRelay {
  if (value.transport !== transport) throw new Error('Relay transport conflict');
  if (transport === 'stdio') {
    const relay = object(value, ['transport', 'executable', 'executableSha256', 'handle']);
    if (relay.executable !== boot.executable || relay.executableSha256 !== boot.executableSha256) throw new Error('Relay executable conflict');
    verifyExecutable(boot.executable, boot.executableSha256);
    const handle = text(relay.handle);
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(handle)) throw new Error('Relay ticket invalid');
    const bytes = Buffer.from(handle, 'base64url');
    if (bytes.toString('base64url') !== handle) throw new Error('Relay ticket invalid');
    const ticket = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), ['endpoint', 'token']);
    // The producer uses Go json.Marshal for this ticket (including HTML and
    // line-separator escapes), rather than the control-channel JSON encoder.
    const encoded = JSON.stringify({ endpoint: ticket.endpoint, token: ticket.token })
      .replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (encoded !== bytes.toString('utf8')) throw new Error('Relay ticket invalid');
    if (ticket.endpoint !== boot.hostConfig.relay_url || !/^[0-9a-f]{64}$/.test(text(ticket.token))) throw new Error('Relay binding conflict');
    const url = new URL(text(ticket.endpoint));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Relay URL invalid');
    return { transport, executable: boot.executable, executableSha256: boot.executableSha256, handle };
  }
  const relay = object(value, ['transport', 'url', 'handle']);
  if (relay.url !== boot.hostConfig.relay_url || !/^[0-9a-f]{64}$/.test(text(relay.handle))) throw new Error('Relay binding conflict');
  return { transport, url: text(relay.url), handle: text(relay.handle) };
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
    // These are real external prerequisites, not operator-selectable factories
    // or a fixture installed as a production authority.
    if (!dependencies) throw new Error('PERMISSION_NATIVE_AND_CONTAINMENT_BINDINGS_UNAVAILABLE');
    let coordinator: Awaited<ReturnType<typeof startPermissionCoordinator>> | undefined;
    let stopped: Promise<void> | undefined;
    const stop = (): Promise<void> => stopped ??= (async () => {
      // Stop workers/native operations before releasing private host authority.
      const results = await Promise.allSettled([dependencies.worker.stop(), dependencies.native.stop()]);
      await coordinator?.stop();
      if (results.some(result => result.status === 'rejected')) throw new Error('Managed shutdown requires quarantine');
    })();
    try {
      await dependencies.native.recover(descriptor.key);
      const journal = new ReplayJournal(adapter, descriptor.journalKey, descriptor.journalKeyVersion, { provision: descriptor.provision });
      journal.recoverInterrupted();
      coordinator = await startPermissionCoordinator({ ...descriptor.boot, botToken: current.botToken,
        origin: descriptor.key.origin, botUid: botId, recipientId: descriptor.recipientId });
      const native = dependencies.native;
      return new EndpointPermissionHost({ key: descriptor.key, recipientId: descriptor.recipientId, relayTransport: descriptor.transport,
        journal, control: coordinator.control, authoritySignal: coordinator.signal,
        inspect: delivery => native.inspect(delivery), candidate: message => native.candidate(message),
        prepareInput: (binding, signal) => native.prepareInput(binding, signal),
        publish: (binding, output, signal) => native.publish(binding, output, signal),
        refuse: (ingress, record, output, signal) => native.refuse(ingress, record, output, signal),
        runWorker: (binding, input, relay, signal) => dependencies.worker.execute(binding, input,
          preparePrivateWorker({ ...descriptor.worker, relay: checkedTurnRelay(relay, descriptor.boot, descriptor.transport) }), signal), stop });
    } catch (error) { await stop(); throw error; }
  };
}
