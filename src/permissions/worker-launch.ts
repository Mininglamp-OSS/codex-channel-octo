import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

export type TurnRelay =
  | { transport: 'stdio'; executable: string; executableSha256: string; handle: string }
  | {
      transport: 'http';
      url: string;
      handle: string;
      caCert?: Uint8Array | string;
      caSha256?: string;
      peerSha256?: string;
    };

export interface VerifiedWorkerResume {
  readonly generation: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly scopeIncarnation: string;
  readonly contextEpoch: string;
  readonly contributorCount: number;
  readonly workdir?: string;
  readonly codexHome?: string;
}

export interface PrivateWorkerLaunch {
  readonly launcher: string;
  readonly workdir: string;
  readonly codexHome: string;
  readonly instructions: string;
  readonly provider?: Readonly<{ baseUrl: string; apiKey?: string }>;
  readonly env: Readonly<Record<string, string>>;
  readonly configOverrides: readonly string[];
  readonly verifiedResume?: Readonly<VerifiedWorkerResume>;
  readonly relayCaPath?: string;
}

export interface IsolatingWorkerLauncherOptions {
  readonly root: string;
  readonly targetExecutable: string;
  readonly targetExecutableSha256: string;
  readonly targetArgs?: readonly string[];
  readonly deniedPaths?: readonly string[];
  readonly allowNetwork?: boolean;
}

export interface PinnedIsolatingLauncher {
  readonly launcher: string;
  readonly launcherSha256: string;
  readonly backend: 'darwin-sandbox-exec' | 'linux-bwrap';
  readonly profilePath?: string;
}

function pinnedExecutable(path: string, digest: string): void {
  if (!isAbsolute(path) || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('Pinned worker executable unavailable');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0
    || createHash('sha256').update(readFileSync(path)).digest('hex') !== digest) throw new Error('Pinned worker executable unavailable');
}

function assertPrivateDirectory(path: string, message: string): void {
  if (!isAbsolute(path)) throw new Error(message);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error(message);
}

function assertInsideRoot(root: string, candidate: string, message: string): void {
  assertPrivateDirectory(candidate, message);
  const rootReal = realpathSync(root);
  const candidateReal = realpathSync(candidate);
  const rel = relative(rootReal, candidateReal);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(message);
}

function writeFreshPrivateFile(path: string, content: string | Uint8Array): void {
  try {
    const prev = lstatSync(path);
    if (!prev.isFile() || prev.isSymbolicLink() || prev.nlink !== 1) {
      throw new Error('Private worker file unavailable');
    }
    rmSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
}

function validateVerifiedResume(root: string, resume: VerifiedWorkerResume): Readonly<VerifiedWorkerResume> {
  if (!/^[0-9a-f]{32}$/.test(resume.generation)
    || !/^[0-9a-f]{32}$/.test(resume.turnId)
    || !/^[0-9a-f]{32}$/.test(resume.scopeIncarnation)
    || !/^(?:0|[1-9][0-9]{0,19})$/.test(resume.contextEpoch)
    || !/^[\x21-\x7e]{1,256}$/.test(resume.sessionId)
    || !Number.isInteger(resume.contributorCount)
    || resume.contributorCount < 1
    || resume.contributorCount > 256) {
    throw new Error('Verified worker resume unavailable');
  }
  if ((resume.workdir !== undefined) !== (resume.codexHome !== undefined)) {
    throw new Error('Verified worker resume unavailable');
  }
  if (resume.workdir !== undefined && resume.codexHome !== undefined) {
    if (resume.workdir === resume.codexHome) throw new Error('Verified worker resume unavailable');
    assertInsideRoot(root, resume.workdir, 'Verified worker resume unavailable');
    assertInsideRoot(root, resume.codexHome, 'Verified worker resume unavailable');
  }
  return Object.freeze({ ...resume });
}

/** Fixed launch-data encoder, not a configuration language/interpreter. */
function inlineTable(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inlineTable).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Worker configuration unavailable');
  return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${inlineTable(item)}`).join(',')}}`;
}

/**
 * Materialize a host-owned, SHA-256-pinned OS-sandboxed worker launcher that
 * denies reading/writing protected host paths (coordinator socket/keys, replay
 * journal, host dataDir) even under the same UID, and restricts filesystem
 * writes to the worker's per-generation workdir and CODEX_HOME.
 */
export function createIsolatingWorkerLauncher(options: IsolatingWorkerLauncherOptions): Readonly<PinnedIsolatingLauncher> {
  assertPrivateDirectory(options.root, 'Private worker root unavailable');
  pinnedExecutable(options.targetExecutable, options.targetExecutableSha256);
  const targetArgs = options.targetArgs ? [...options.targetArgs] : [];
  if (!targetArgs.every(arg => typeof arg === 'string' && !arg.includes('\0'))) {
    throw new Error('Pinned worker executable unavailable');
  }
  const deniedSet = new Set<string>();
  for (const rawPath of options.deniedPaths ?? []) {
    if (typeof rawPath !== 'string' || !isAbsolute(rawPath) || /[\0\r\n"\\]/.test(rawPath)) {
      throw new Error('Isolated worker denied path unavailable');
    }
    deniedSet.add(rawPath);
    if (existsSync(rawPath)) {
      const resolved = realpathSync(rawPath);
      if (/[\0\r\n"\\]/.test(resolved)) throw new Error('Isolated worker denied path unavailable');
      deniedSet.add(resolved);
    }
  }
  const deniedPaths = [...deniedSet];
  const launcherDir = mkdtempSync(join(options.root, 'isolated-launcher-'));
  chmodSync(launcherDir, 0o700);
  const targetRealpath = realpathSync(options.targetExecutable);

  if (process.platform === 'darwin') {
    const sandboxExec = '/usr/bin/sandbox-exec';
    if (!existsSync(sandboxExec)) throw new Error('OS sandbox launcher unavailable');
    const sbStat = lstatSync(sandboxExec);
    if (!sbStat.isFile() || sbStat.isSymbolicLink() || (sbStat.mode & 0o111) === 0) {
      throw new Error('OS sandbox launcher unavailable');
    }
    const profilePath = join(launcherDir, 'worker.sb');
    const denyRules = deniedPaths.flatMap(p => [
      `(deny file-read* file-write* (subpath ${JSON.stringify(p)}) (literal ${JSON.stringify(p)}))`,
    ]);
    const networkRules = options.allowNetwork === false
      ? [
          '(deny network-outbound (remote ip))',
          '(allow network-outbound (remote ip "localhost:*"))',
        ]
      : [];
    const profileLines = [
      '(version 1)',
      '(allow default)',
      '(deny file-write* (subpath "/"))',
      ...networkRules,
      ...denyRules,
      '(allow file-read-metadata (subpath "/"))',
      `(allow file-read* (literal ${JSON.stringify(options.targetExecutable)}) (literal ${JSON.stringify(targetRealpath)}))`,
      '(allow file-read* file-write* (subpath (param "WORKER_CWD")) (subpath (param "CODEX_HOME")) (subpath (param "WORKER_CWD_LEX")) (subpath (param "CODEX_HOME_LEX")))',
      '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    ];
    writeFileSync(profilePath, profileLines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    const profileRealpath = realpathSync(profilePath);
    const finalProfile = [
      ...profileLines,
      `(allow file-read* (literal ${JSON.stringify(profilePath)}) (literal ${JSON.stringify(profileRealpath)}))`,
    ].join('\n') + '\n';
    writeFreshPrivateFile(profilePath, finalProfile);

    const launcherPath = join(launcherDir, 'isolated-worker');
    const wrapperSource = `#!${process.execPath}
const { spawn } = require('node:child_process');
const { isAbsolute } = require('node:path');
const { realpathSync } = require('node:fs');
const cwdLex = process.cwd();
const codexHomeLex = process.env.CODEX_HOME || '';
if (!isAbsolute(cwdLex) || !isAbsolute(codexHomeLex)) {
  process.stderr.write('Isolated worker requires absolute cwd and CODEX_HOME\\n');
  process.exit(78);
}
const cwdReal = realpathSync(cwdLex);
const codexHomeReal = realpathSync(codexHomeLex);
const args = [
  '-f', ${JSON.stringify(profileRealpath)},
  '-D', 'WORKER_CWD=' + cwdReal,
  '-D', 'CODEX_HOME=' + codexHomeReal,
  '-D', 'WORKER_CWD_LEX=' + cwdLex,
  '-D', 'CODEX_HOME_LEX=' + codexHomeLex,
  ${JSON.stringify(options.targetExecutable)},
  ...${JSON.stringify(targetArgs)},
  ...process.argv.slice(2),
];
const child = spawn(${JSON.stringify(sandboxExec)}, args, { stdio: 'inherit', env: process.env });
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { try { child.kill(sig); } catch {} });
}
child.on('exit', (code, signal) => {
  if (signal) { try { process.kill(process.pid, signal); } catch {} process.exit(1); }
  process.exit(code ?? 1);
});
child.on('error', () => process.exit(78));
`;
    writeFileSync(launcherPath, wrapperSource, { mode: 0o700, flag: 'wx' });
    const launcherSha256 = createHash('sha256').update(wrapperSource).digest('hex');
    pinnedExecutable(launcherPath, launcherSha256);
    return Object.freeze({
      launcher: launcherPath,
      launcherSha256,
      backend: 'darwin-sandbox-exec',
      profilePath: profileRealpath,
    });
  }

  if (process.platform === 'linux') {
    const bwrap = ['/usr/bin/bwrap', '/bin/bwrap'].find(candidate => {
      if (!existsSync(candidate)) return false;
      const st = lstatSync(candidate);
      return st.isFile() && !st.isSymbolicLink() && (st.mode & 0o111) !== 0;
    });
    if (!bwrap) throw new Error('OS sandbox launcher unavailable');
    const launcherPath = join(launcherDir, 'isolated-worker');
    const wrapperSource = `#!${process.execPath}
const { spawn } = require('node:child_process');
const { existsSync, lstatSync, realpathSync } = require('node:fs');
const { isAbsolute } = require('node:path');
const cwdLex = process.cwd();
const codexHomeLex = process.env.CODEX_HOME || '';
if (!isAbsolute(cwdLex) || !isAbsolute(codexHomeLex)) {
  process.stderr.write('Isolated worker requires absolute cwd and CODEX_HOME\\n');
  process.exit(78);
}
const cwdReal = realpathSync(cwdLex);
const codexHomeReal = realpathSync(codexHomeLex);
const bwrapArgs = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-ipc', '--die-with-parent'];
const sortedDenied = [...${JSON.stringify(deniedPaths)}].sort((a, b) => a.length - b.length);
const deniedDirs = [];
for (const denied of sortedDenied) {
  if (!existsSync(denied)) continue;
  const st = lstatSync(denied);
  if (st.isDirectory()) { bwrapArgs.push('--tmpfs', denied); deniedDirs.push(denied); }
  else if (st.isFile()) bwrapArgs.push('--ro-bind', '/dev/null', denied);
}
bwrapArgs.push('--ro-bind', ${JSON.stringify(targetRealpath)}, ${JSON.stringify(targetRealpath)});
if (${JSON.stringify(options.targetExecutable)} !== ${JSON.stringify(targetRealpath)}) {
  bwrapArgs.push('--ro-bind', ${JSON.stringify(options.targetExecutable)}, ${JSON.stringify(options.targetExecutable)});
}
bwrapArgs.push('--bind', cwdReal, cwdReal, '--bind', codexHomeReal, codexHomeReal);
for (const dir of [...deniedDirs].reverse()) {
  if (dir !== cwdReal && dir !== codexHomeReal && dir !== cwdLex && dir !== codexHomeLex) {
    bwrapArgs.push('--remount-ro', dir);
  }
}
bwrapArgs.push('--', ${JSON.stringify(options.targetExecutable)}, ...${JSON.stringify(targetArgs)}, ...process.argv.slice(2));
const child = spawn(${JSON.stringify(bwrap)}, bwrapArgs, { stdio: 'inherit', env: process.env });
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { try { child.kill(sig); } catch {} });
}
child.on('exit', (code, signal) => {
  if (signal) { try { process.kill(process.pid, signal); } catch {} process.exit(1); }
  process.exit(code ?? 1);
});
child.on('error', () => process.exit(78));
`;
    writeFileSync(launcherPath, wrapperSource, { mode: 0o700, flag: 'wx' });
    const launcherSha256 = createHash('sha256').update(wrapperSource).digest('hex');
    pinnedExecutable(launcherPath, launcherSha256);
    return Object.freeze({
      launcher: launcherPath,
      launcherSha256,
      backend: 'linux-bwrap',
    });
  }

  throw new Error('OS sandbox launcher unavailable');
}

/**
 * Host-owned launch preparation. The pinned launcher must implement the actual
 * OS/process/network/FD isolation profile; private directories or SDK flags are
 * not substitutes for it. No host credential/config/environment is inherited.
 */
export function preparePrivateWorker(options: {
  root: string; launcher: string; launcherSha256: string; relay: TurnRelay; instructions: string;
  provider?: { baseUrl: string; apiKey?: string };
  verifiedResume?: VerifiedWorkerResume;
}): Readonly<PrivateWorkerLaunch> {
  pinnedExecutable(options.launcher, options.launcherSha256);
  assertPrivateDirectory(options.root, 'Private worker root unavailable');
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(options.relay.handle)) throw new Error('Turn relay handle unavailable');
  const verifiedResume = options.verifiedResume !== undefined
    ? validateVerifiedResume(options.root, options.verifiedResume)
    : undefined;
  let provider: Readonly<{ baseUrl: string; apiKey?: string }> | undefined;
  if (options.provider) {
    const url = new URL(options.provider.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
      || (options.provider.apiKey !== undefined && (typeof options.provider.apiKey !== 'string' || !options.provider.apiKey))) {
      throw new Error('Explicit model provider unavailable');
    }
    provider = Object.freeze({ baseUrl: url.href, ...(options.provider.apiKey ? { apiKey: options.provider.apiKey } : {}) });
  }
  let relayCaBytes: Buffer | undefined;
  let server: Record<string, unknown>;
  if (options.relay.transport === 'stdio') {
    pinnedExecutable(options.relay.executable, options.relay.executableSha256);
    server = { command: options.relay.executable, args: ['--turn-relay', options.relay.handle], env: {} };
  } else {
    const url = new URL(options.relay.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Turn relay URL unavailable');
    if (options.relay.caSha256 !== undefined && !/^[0-9a-f]{64}$/.test(options.relay.caSha256)) {
      throw new Error('Turn relay CA digest unavailable');
    }
    if (options.relay.peerSha256 !== undefined && !/^[0-9a-f]{64}$/.test(options.relay.peerSha256)) {
      throw new Error('Turn relay peer digest unavailable');
    }
    if (options.relay.caCert !== undefined) {
      relayCaBytes = typeof options.relay.caCert === 'string'
        ? Buffer.from(options.relay.caCert, 'utf8')
        : Buffer.from(options.relay.caCert);
      if (relayCaBytes.byteLength === 0 || relayCaBytes.byteLength > 65536
        || !relayCaBytes.toString('utf8').includes('-----BEGIN CERTIFICATE-----')) {
        throw new Error('Turn relay CA bundle unavailable');
      }
    }
    server = { url: url.href, http_headers: { Authorization: `Bearer ${options.relay.handle}` } };
  }
  let workdir: string;
  let codexHome: string;
  if (verifiedResume?.workdir && verifiedResume?.codexHome) {
    workdir = verifiedResume.workdir;
    codexHome = verifiedResume.codexHome;
    writeFreshPrivateFile(join(workdir, 'AGENTS.md'), options.instructions);
  } else {
    const generation = mkdtempSync(join(options.root, 'generation-'));
    chmodSync(generation, 0o700);
    workdir = join(generation, 'work');
    codexHome = join(generation, 'codex');
    mkdirSync(workdir, { mode: 0o700 }); mkdirSync(codexHome, { mode: 0o700 });
    writeFileSync(join(workdir, 'AGENTS.md'), options.instructions, { mode: 0o600, flag: 'wx' });
  }
  let relayCaPath: string | undefined;
  const envRecord: Record<string, string> = { CODEX_HOME: codexHome };
  if (relayCaBytes) {
    relayCaPath = join(codexHome, 'relay-ca.pem');
    writeFreshPrivateFile(relayCaPath, relayCaBytes);
    envRecord.SSL_CERT_FILE = relayCaPath;
    envRecord.NODE_EXTRA_CA_CERTS = relayCaPath;
    if (server.env && typeof server.env === 'object') {
      server = { ...server, env: { ...(server.env as Record<string, string>), SSL_CERT_FILE: relayCaPath, NODE_EXTRA_CA_CERTS: relayCaPath } };
    }
  }
  // Explicit clean home + working tree, rather than assuming an empty table
  // override erases an inherited server. Native precedence is separately tested.
  const configOverrides = Object.freeze([
    `mcp_servers=${inlineTable({ octo: server })}`, 'web_search="disabled"',
    'project_doc_max_bytes=0', 'approval_policy="never"', 'sandbox_mode="read-only"',
  ]);
  return Object.freeze({
    launcher: options.launcher,
    workdir,
    codexHome,
    instructions: options.instructions,
    ...(provider ? { provider } : {}),
    ...(verifiedResume ? { verifiedResume } : {}),
    ...(relayCaPath ? { relayCaPath } : {}),
    env: Object.freeze(envRecord),
    configOverrides,
  });
}
