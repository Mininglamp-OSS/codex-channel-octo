import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type TurnRelay =
  | { transport: 'stdio'; executable: string; executableSha256: string; handle: string }
  | { transport: 'http'; url: string; handle: string };

export interface PrivateWorkerLaunch {
  readonly launcher: string;
  readonly workdir: string;
  readonly codexHome: string;
  readonly instructions: string;
  readonly provider?: Readonly<{ baseUrl: string; apiKey?: string }>;
  readonly env: Readonly<Record<string, string>>;
  readonly configOverrides: readonly string[];
}

function pinnedExecutable(path: string, digest: string): void {
  if (!isAbsolute(path) || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('Pinned worker executable unavailable');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0
    || createHash('sha256').update(readFileSync(path)).digest('hex') !== digest) throw new Error('Pinned worker executable unavailable');
}

/** Fixed launch-data encoder, not a configuration language/interpreter. */
function inlineTable(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inlineTable).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Worker configuration unavailable');
  return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${inlineTable(item)}`).join(',')}}`;
}

/**
 * Host-owned launch preparation. The pinned launcher must implement the actual
 * OS/process/network/FD isolation profile; private directories or SDK flags are
 * not substitutes for it. No host credential/config/environment is inherited.
 */
export function preparePrivateWorker(options: {
  root: string; launcher: string; launcherSha256: string; relay: TurnRelay; instructions: string;
  provider?: { baseUrl: string; apiKey?: string };
}): Readonly<PrivateWorkerLaunch> {
  pinnedExecutable(options.launcher, options.launcherSha256);
  if (!isAbsolute(options.root)) throw new Error('Private worker root unavailable');
  const parent = lstatSync(options.root);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw new Error('Private worker root unavailable');
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(options.relay.handle)) throw new Error('Turn relay handle unavailable');
  let provider: Readonly<{ baseUrl: string; apiKey?: string }> | undefined;
  if (options.provider) {
    const url = new URL(options.provider.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
      || (options.provider.apiKey !== undefined && (typeof options.provider.apiKey !== 'string' || !options.provider.apiKey))) {
      throw new Error('Explicit model provider unavailable');
    }
    provider = Object.freeze({ baseUrl: url.href, ...(options.provider.apiKey ? { apiKey: options.provider.apiKey } : {}) });
  }
  let server: Record<string, unknown>;
  if (options.relay.transport === 'stdio') {
    pinnedExecutable(options.relay.executable, options.relay.executableSha256);
    server = { command: options.relay.executable, args: ['--turn-relay', options.relay.handle], env: {} };
  } else {
    const url = new URL(options.relay.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Turn relay URL unavailable');
    server = { url: url.href, http_headers: { Authorization: `Bearer ${options.relay.handle}` } };
  }
  const generation = mkdtempSync(join(options.root, 'generation-'));
  const workdir = join(generation, 'work');
  const codexHome = join(generation, 'codex');
  mkdirSync(workdir, { mode: 0o700 }); mkdirSync(codexHome, { mode: 0o700 });
  writeFileSync(join(workdir, 'AGENTS.md'), options.instructions, { mode: 0o600, flag: 'wx' });
  // Explicit clean home + working tree, rather than assuming an empty table
  // override erases an inherited server. Native precedence is separately tested.
  const configOverrides = Object.freeze([
    `mcp_servers=${inlineTable({ octo: server })}`, 'web_search="disabled"',
    'project_doc_max_bytes=0', 'approval_policy="never"', 'sandbox_mode="read-only"',
  ]);
  return Object.freeze({ launcher: options.launcher, workdir, codexHome,
    instructions: options.instructions, ...(provider ? { provider } : {}),
    env: Object.freeze({ CODEX_HOME: codexHome }), configOverrides });
}
