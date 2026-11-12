import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { connect as tlsConnect } from 'node:tls';

export interface TurnRelayTrust {
  readonly ca_file?: string;
  readonly ca_pem?: string;
  readonly ca_sha256?: string;
  readonly peer_sha256?: string;
  readonly cert_sha256?: string;
  readonly server_name?: string;
}

export type TurnRelay =
  | {
      transport: 'stdio';
      executable: string;
      executableSha256: string;
      handle: string;
      tls?: Readonly<TurnRelayTrust>;
      caCert?: Uint8Array | string;
      caSha256?: string;
      peerSha256?: string;
    }
  | {
      transport: 'http';
      url: string;
      handle: string;
      tls?: Readonly<TurnRelayTrust>;
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
  readonly relayTls?: Readonly<TurnRelayTrust>;
  readonly relayUrl?: string;
}

export interface IsolatingWorkerLauncherOptions {
  readonly root: string;
  readonly targetExecutable: string;
  readonly targetExecutableSha256: string;
  readonly targetArgs?: readonly string[];
  readonly deniedPaths?: readonly string[];
  readonly allowNetwork?: boolean;
  readonly platform?: 'darwin' | 'linux';
  readonly sandboxExecutable?: string;
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
  const targetPlatform = options.platform ?? process.platform;

  if (targetPlatform === 'darwin') {
    const sandboxExec = options.sandboxExecutable ?? '/usr/bin/sandbox-exec';
    if (!isAbsolute(sandboxExec) || !existsSync(sandboxExec)) throw new Error('OS sandbox launcher unavailable');
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

  if (targetPlatform === 'linux') {
    const candidates = options.sandboxExecutable ? [options.sandboxExecutable] : ['/usr/bin/bwrap', '/bin/bwrap'];
    const bwrap = candidates.find(candidate => {
      if (!isAbsolute(candidate) || !existsSync(candidate)) return false;
      const st = lstatSync(candidate);
      return st.isFile() && !st.isSymbolicLink() && (st.mode & 0o111) !== 0;
    });
    if (!bwrap) throw new Error('OS sandbox launcher unavailable');
    const bwrapBaseArgs = [
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--unshare-ipc',
      ...(options.allowNetwork === false ? ['--unshare-net'] : []),
      '--die-with-parent',
    ];
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
const bwrapArgs = ${JSON.stringify(bwrapBaseArgs)};
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

export function validRelayServerName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  if (/[/:\r\n\t\\ ]/.test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 33 || code > 126) return false;
  }
  return true;
}

function readRelayCaFile(caFile: string): Buffer {
  if (!isAbsolute(caFile) || /[\r\n\0]/.test(caFile)) {
    throw new Error('Turn relay CA file unavailable');
  }
  const stat = lstatSync(caFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 256 * 1024) {
    throw new Error('Turn relay CA file unavailable');
  }
  const bytes = readFileSync(caFile);
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024 || !bytes.toString('utf8').includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('Turn relay CA file unavailable');
  }
  return bytes;
}

function validateTurnRelayTrust(tls: TurnRelayTrust | undefined): {
  trust?: Readonly<TurnRelayTrust>;
  caBytes?: Buffer;
} {
  if (tls === undefined) return {};
  if (!tls || typeof tls !== 'object' || Array.isArray(tls)) {
    throw new Error('Turn relay trust unavailable');
  }
  const allowed = new Set(['ca_file', 'ca_pem', 'ca_sha256', 'peer_sha256', 'cert_sha256', 'server_name']);
  for (const key of Object.keys(tls)) {
    if (!allowed.has(key)) throw new Error('Turn relay trust unavailable');
  }
  let caBytes: Buffer | undefined;
  const out: {
    ca_file?: string;
    ca_sha256?: string;
    peer_sha256?: string;
    cert_sha256?: string;
    server_name?: string;
  } = {};
  if (tls.ca_file !== undefined) {
    if (typeof tls.ca_file !== 'string' || !tls.ca_file) throw new Error('Turn relay CA file unavailable');
    caBytes = readRelayCaFile(tls.ca_file);
    out.ca_file = tls.ca_file;
  }
  if (tls.ca_pem !== undefined) {
    if (typeof tls.ca_pem !== 'string' || !tls.ca_pem) throw new Error('Turn relay CA bundle unavailable');
    const pemBytes = Buffer.from(tls.ca_pem, 'utf8');
    if (pemBytes.byteLength === 0 || pemBytes.byteLength > 256 * 1024 || !tls.ca_pem.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('Turn relay CA bundle unavailable');
    }
    if (caBytes && Buffer.compare(caBytes, pemBytes) !== 0) {
      throw new Error('Turn relay CA bundle mismatch');
    }
    caBytes = pemBytes;
  }
  if (tls.ca_sha256 !== undefined) {
    if (typeof tls.ca_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(tls.ca_sha256)) {
      throw new Error('Turn relay CA digest unavailable');
    }
    if (caBytes && createHash('sha256').update(caBytes).digest('hex') !== tls.ca_sha256) {
      throw new Error('Turn relay CA digest mismatch');
    }
    out.ca_sha256 = tls.ca_sha256;
  }
  if (tls.peer_sha256 !== undefined) {
    if (typeof tls.peer_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(tls.peer_sha256)) {
      throw new Error('Turn relay peer digest unavailable');
    }
    out.peer_sha256 = tls.peer_sha256;
  }
  if (tls.cert_sha256 !== undefined) {
    if (typeof tls.cert_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(tls.cert_sha256)) {
      throw new Error('Turn relay certificate digest unavailable');
    }
    out.cert_sha256 = tls.cert_sha256;
  }
  if (out.peer_sha256 !== undefined && out.cert_sha256 !== undefined && out.peer_sha256 !== out.cert_sha256) {
    throw new Error('Turn relay peer digest mismatch');
  }
  if (out.peer_sha256 !== undefined && out.cert_sha256 === undefined) {
    out.cert_sha256 = out.peer_sha256;
  }
  if (tls.server_name !== undefined) {
    if (!validRelayServerName(tls.server_name)) {
      throw new Error('Turn relay server_name unavailable');
    }
    out.server_name = tls.server_name;
  }
  return { trust: Object.freeze(out), ...(caBytes ? { caBytes } : {}) };
}

function encodeGoRelayTicket(ticket: {
  ca_file?: string;
  ca_sha256?: string;
  cert_sha256?: string;
  endpoint: string;
  peer_sha256?: string;
  server_name?: string;
  token: string;
}): string {
  const ordered: Record<string, string> = {};
  if (ticket.ca_file) ordered.ca_file = ticket.ca_file;
  if (ticket.ca_sha256) ordered.ca_sha256 = ticket.ca_sha256;
  if (ticket.cert_sha256) ordered.cert_sha256 = ticket.cert_sha256;
  ordered.endpoint = ticket.endpoint;
  if (ticket.peer_sha256) ordered.peer_sha256 = ticket.peer_sha256;
  if (ticket.server_name) ordered.server_name = ticket.server_name;
  ordered.token = ticket.token;
  const json = JSON.stringify(ordered)
    .replace(/[<>&\u2028\u2029]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return Buffer.from(json, 'utf8').toString('base64url');
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
  const validatedTls = validateTurnRelayTrust(options.relay.tls);
  let relayCaBytes: Buffer | undefined = validatedTls.caBytes;
  let parsedStdioTicket: {
    endpoint: string;
    token: string;
    ca_file?: string;
    ca_sha256?: string;
    peer_sha256?: string;
    cert_sha256?: string;
    server_name?: string;
  } | undefined;
  if (options.relay.caCert !== undefined && relayCaBytes === undefined) {
    relayCaBytes = typeof options.relay.caCert === 'string'
      ? Buffer.from(options.relay.caCert, 'utf8')
      : Buffer.from(options.relay.caCert);
    if (relayCaBytes.byteLength === 0 || relayCaBytes.byteLength > 256 * 1024
      || !relayCaBytes.toString('utf8').includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('Turn relay CA bundle unavailable');
    }
  }
  if (options.relay.caSha256 !== undefined && !/^[0-9a-f]{64}$/.test(options.relay.caSha256)) {
    throw new Error('Turn relay CA digest unavailable');
  }
  if (options.relay.peerSha256 !== undefined && !/^[0-9a-f]{64}$/.test(options.relay.peerSha256)) {
    throw new Error('Turn relay peer digest unavailable');
  }
  let server: Record<string, unknown>;
  let relayUrl: string | undefined;
  if (options.relay.transport === 'stdio') {
    pinnedExecutable(options.relay.executable, options.relay.executableSha256);
    try {
      const rawBytes = Buffer.from(options.relay.handle, 'base64url');
      if (rawBytes.toString('base64url') === options.relay.handle) {
        const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes)) as Record<string, unknown>;
        if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)
          && typeof decoded.endpoint === 'string' && typeof decoded.token === 'string') {
          const ticketTrust = validateTurnRelayTrust({
            ...(typeof decoded.ca_file === 'string' ? { ca_file: decoded.ca_file } : {}),
            ...(typeof decoded.ca_sha256 === 'string' ? { ca_sha256: decoded.ca_sha256 } : {}),
            ...(typeof decoded.peer_sha256 === 'string' ? { peer_sha256: decoded.peer_sha256 } : {}),
            ...(typeof decoded.cert_sha256 === 'string' ? { cert_sha256: decoded.cert_sha256 } : {}),
            ...(typeof decoded.server_name === 'string' ? { server_name: decoded.server_name } : {}),
          });
          if (relayCaBytes === undefined && ticketTrust.caBytes) {
            relayCaBytes = ticketTrust.caBytes;
          }
          parsedStdioTicket = {
            endpoint: decoded.endpoint,
            token: decoded.token,
            ...(ticketTrust.trust?.ca_file ? { ca_file: ticketTrust.trust.ca_file } : {}),
            ...(ticketTrust.trust?.ca_sha256 ? { ca_sha256: ticketTrust.trust.ca_sha256 } : {}),
            ...(ticketTrust.trust?.peer_sha256 ? { peer_sha256: ticketTrust.trust.peer_sha256 } : {}),
            ...(ticketTrust.trust?.cert_sha256 ? { cert_sha256: ticketTrust.trust.cert_sha256 } : {}),
            ...(ticketTrust.trust?.server_name ? { server_name: ticketTrust.trust.server_name } : {}),
          };
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Turn relay ')) throw err;
    }
    server = { command: options.relay.executable, args: ['--turn-relay', options.relay.handle], env: {} };
  } else {
    const url = new URL(options.relay.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Turn relay URL unavailable');
    relayUrl = url.href;
    server = { url: url.href, http_headers: { Authorization: `Bearer ${options.relay.handle}` } };
  }
  const caSha256Candidates = [
    options.relay.caSha256,
    validatedTls.trust?.ca_sha256,
    parsedStdioTicket?.ca_sha256,
  ].filter((v): v is string => v !== undefined);
  const caSha256 = caSha256Candidates[0];
  if (caSha256Candidates.some(v => v !== caSha256)) {
    throw new Error('Turn relay CA digest mismatch');
  }
  if (caSha256 !== undefined) {
    if (!relayCaBytes) {
      throw new Error('Turn relay CA bundle unavailable for pinned ca_sha256');
    }
    const actualCaSha256 = createHash('sha256').update(relayCaBytes).digest('hex');
    if (actualCaSha256 !== caSha256) {
      throw new Error('Turn relay CA digest mismatch');
    }
  }
  const peerSha256Candidates = [
    options.relay.peerSha256,
    validatedTls.trust?.cert_sha256,
    validatedTls.trust?.peer_sha256,
    parsedStdioTicket?.cert_sha256,
    parsedStdioTicket?.peer_sha256,
  ].filter((v): v is string => v !== undefined);
  const certSha256 = peerSha256Candidates[0];
  if (peerSha256Candidates.some(v => v !== certSha256)) {
    throw new Error('Turn relay peer digest mismatch');
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
  const serverName = validatedTls.trust?.server_name ?? parsedStdioTicket?.server_name;
  if (options.relay.transport === 'stdio' && parsedStdioTicket && (relayCaPath || caSha256 || certSha256 || serverName)) {
    const withStagedCaAndDigest = encodeGoRelayTicket({
      ...(relayCaPath ? { ca_file: relayCaPath } : {}),
      ...(caSha256 ? { ca_sha256: caSha256 } : {}),
      ...(certSha256 ? { cert_sha256: certSha256 } : {}),
      endpoint: parsedStdioTicket.endpoint,
      ...(serverName ? { server_name: serverName } : {}),
      token: parsedStdioTicket.token,
    });
    const withStagedCa = encodeGoRelayTicket({
      ...(relayCaPath ? { ca_file: relayCaPath } : {}),
      ...(certSha256 ? { cert_sha256: certSha256 } : {}),
      endpoint: parsedStdioTicket.endpoint,
      ...(serverName ? { server_name: serverName } : {}),
      token: parsedStdioTicket.token,
    });
    const effectiveHandle = withStagedCaAndDigest.length <= 512
      ? withStagedCaAndDigest
      : withStagedCa.length <= 512
        ? withStagedCa
        : encodeGoRelayTicket({
            ...(caSha256 ? { ca_sha256: caSha256 } : {}),
            ...(certSha256 ? { cert_sha256: certSha256 } : {}),
            endpoint: parsedStdioTicket.endpoint,
            ...(serverName ? { server_name: serverName } : {}),
            token: parsedStdioTicket.token,
          });
    server = { ...server, args: ['--turn-relay', effectiveHandle] };
  }
  const explicitPeerField = validatedTls.trust?.peer_sha256 ?? parsedStdioTicket?.peer_sha256 ?? options.relay.peerSha256;
  const relayTls: Readonly<TurnRelayTrust> | undefined = (relayCaPath || validatedTls.trust?.ca_file || caSha256 || certSha256 || serverName)
    ? Object.freeze({
        ...((relayCaPath ?? validatedTls.trust?.ca_file) ? { ca_file: relayCaPath ?? validatedTls.trust?.ca_file } : {}),
        ...(caSha256 ? { ca_sha256: caSha256 } : {}),
        ...(explicitPeerField && !validatedTls.trust?.cert_sha256 ? { peer_sha256: explicitPeerField } : {}),
        ...(certSha256 ? { cert_sha256: certSha256 } : {}),
        ...(serverName ? { server_name: serverName } : {}),
      })
    : undefined;
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
    ...(relayTls ? { relayTls } : {}),
    ...(relayUrl ? { relayUrl } : {}),
    env: Object.freeze(envRecord),
    configOverrides,
  });
}

/**
 * Cryptographically verify the HTTP turn relay TLS 1.3 handshake, custom CA
 * bundle (`ca_sha256` / `ca_file`), `server_name`, and leaf certificate digest
 * (`cert_sha256` / `peer_sha256`) before executing a worker against an HTTP relay.
 */
export async function verifyHttpRelayTlsPin(
  launch: Readonly<PrivateWorkerLaunch>,
  signal?: AbortSignal,
): Promise<void> {
  if (!launch.relayUrl || !launch.relayTls) return;
  const trust = launch.relayTls;
  const expectedPeerSha256 = trust.cert_sha256 ?? trust.peer_sha256;
  const expectedCaSha256 = trust.ca_sha256;
  const caPath = launch.relayCaPath ?? trust.ca_file;
  if (!expectedPeerSha256 && !expectedCaSha256 && !caPath && !trust.server_name) return;

  signal?.throwIfAborted();
  const parsed = new URL(launch.relayUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error('Turn relay URL unavailable');
  }
  let caBytes: Buffer | undefined;
  if (caPath) {
    caBytes = readRelayCaFile(caPath);
  }
  if (expectedCaSha256) {
    if (!caBytes) throw new Error('Turn relay CA bundle unavailable');
    const actualCaSha256 = createHash('sha256').update(caBytes).digest('hex');
    if (actualCaSha256 !== expectedCaSha256) {
      throw new Error('Turn relay CA digest mismatch');
    }
  }

  const host = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 443;
  const servername = trust.server_name ?? host;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => finish(new Error('Turn relay TLS verification aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish(new Error('Turn relay TLS verification timed out')), 5000);
    const socket = tlsConnect({
      host,
      port,
      servername,
      ...(caBytes ? { ca: caBytes } : {}),
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      rejectUnauthorized: true,
    });
    socket.once('error', (err) => finish(new Error(`Turn relay TLS verification failed: ${err.message}`)));
    socket.once('secureConnect', () => {
      try {
        if (socket.getProtocol() !== 'TLSv1.3') {
          finish(new Error('Turn relay requires TLS 1.3'));
          return;
        }
        const peer = socket.getPeerCertificate(false);
        if (!peer || !peer.raw || peer.raw.byteLength === 0) {
          finish(new Error('Turn relay peer certificate unavailable'));
          return;
        }
        if (expectedPeerSha256) {
          const actualPeerSha256 = createHash('sha256').update(peer.raw).digest('hex');
          if (actualPeerSha256 !== expectedPeerSha256) {
            finish(new Error('Turn relay peer certificate digest mismatch'));
            return;
          }
        }
        finish();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
