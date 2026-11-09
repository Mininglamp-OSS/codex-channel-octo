import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PermissionControlClient, canonicalControl, decodeControl, object, type ControlConnection } from './control-client.js';
import { privateDirectory, privateFile, verifyExecutable } from './private-files.js';

export interface CoordinatorBoot {
  root: string;
  executable: string;
  executableSha256: string;
  hostConfig: Readonly<Record<string, unknown>>;
  botToken: string;
  origin: string;
  botUid: string;
  recipientId: string;
  tls: Omit<ControlConnection, 'configuredOrigin' | 'recipientId' | 'endpointIncarnation' | 'coordinatorIncarnation'>;
  timeoutMs?: number;
}

function durableFile(path: string, bytes: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Own exactly one CLI boot. No attach-to-an-old-ready-file, automatic restart,
 * ambient CLI account/config, alternate listener or unmanaged fallback. */
export async function startPermissionCoordinator(options: CoordinatorBoot): Promise<{
  control: PermissionControlClient; directory: string; signal: AbortSignal; stop(): Promise<void>;
}> {
  privateDirectory(options.root);
  verifyExecutable(options.executable, options.executableSha256);
  if (options.hostConfig.origin !== options.origin || options.hostConfig.bot_uid !== options.botUid
    || options.hostConfig.recipient_id !== options.recipientId || !options.botToken.startsWith('bf_')) {
    throw new Error('Coordinator host binding unavailable');
  }
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error('Coordinator startup bound unavailable');
  const directory = mkdtempSync(join(options.root, 'coordinator-'));
  const ready = join(directory, 'ready.json');
  const hostPath = join(directory, 'host.json');
  const home = join(directory, 'home');
  const logs = join(directory, 'requests');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(logs, { mode: 0o700 });
  const endpointIncarnation = randomBytes(16).toString('hex');
  durableFile(hostPath, canonicalControl({ ...options.hostConfig, endpoint_incarnation: endpointIncarnation,
    ready_path: ready, relay_executable: options.executable }));
  const directoryFd = openSync(directory, 'r');
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  // Only the trusted coordinator receives the explicitly selected Bot token.
  // In particular no task token, credential mode, PATH, HOME or config survives.
  const child = spawn(options.executable, ['mcp', 'serve', '--permission-config', hostPath], {
    cwd: directory, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
    env: { HOME: home, OCTO_TOKEN: options.botToken, OCTO_API_BASE_URL: options.origin, OCTO_MCP_REQUEST_LOG_DIR: logs },
  });
  let closed = false;
  const lifetime = new AbortController();
  let failed = false;
  let control: PermissionControlClient | undefined;
  const completion = new Promise<void>(resolve => {
    child.once('error', () => { failed = true; });
    child.once('close', () => { closed = true; lifetime.abort(); control?.close(); resolve(); });
  });
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    control?.close();
    lifetime.abort();
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid && !closed) { try { process.kill(-child.pid, signal); } catch { /* collect owned close below */ } }
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 1000);
    try { await completion; } finally { clearTimeout(timer); }
    // Retain private boot evidence. Never delete replay state or reuse ready.
  })();
  try {
    const deadline = Date.now() + timeout;
    let incarnation: string | undefined;
    while (Date.now() < deadline && !closed && !failed) {
      try {
        const record = object(decodeControl(privateFile(ready, 256)), ['control_version', 'coordinator_incarnation']);
        if (record.control_version !== 1 || typeof record.coordinator_incarnation !== 'string'
          || !/^[0-9a-f]{32}$/.test(record.coordinator_incarnation)) throw new Error('Coordinator readiness invalid');
        incarnation = record.coordinator_incarnation; break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Coordinator readiness invalid');
      }
      await sleep(10);
    }
    if (!incarnation || closed || failed) throw new Error('Coordinator boot unavailable');
    control = await PermissionControlClient.connect({ ...options.tls, configuredOrigin: options.origin,
      recipientId: options.recipientId, endpointIncarnation, coordinatorIncarnation: incarnation });
    if (closed || failed) throw new Error('Coordinator boot lost');
    return { control, directory, signal: lifetime.signal, stop };
  } catch (error) { await stop(); throw error; }
}
