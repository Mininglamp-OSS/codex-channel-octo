import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createIsolatingWorkerLauncher, postHttpTurnRelay, preparePrivateWorker, verifyHttpRelayTlsPin } from '../permissions/worker-launch.js';
import { queryAgentEvents } from '../agent-bridge.js';
import type { ManagedExecution } from '../execution-scope.js';
import type { Config } from '../config.js';

const exec = promisify(execFile);
let root: string;
let launcher: string;
let digest: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'permission-worker-'));
  launcher = join(root, 'synthetic-worker');
  const code = `#!${process.execPath}
const initialCwd=process.cwd();let input='';for await(const chunk of process.stdin)input+=chunk;
const args=process.argv.slice(2);const cd=args.indexOf('--cd');if(cd>=0)process.chdir(args[cd+1]);
const report={keys:Object.keys(process.env).sort(),args,home:process.env.CODEX_HOME,cwd:process.cwd(),initialCwd,input};
console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(report)}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));
`;
  writeFileSync(launcher, code, { mode: 0o700 }); digest = createHash('sha256').update(code).digest('hex');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const plan = () => preparePrivateWorker({ root, launcher, launcherSha256: digest,
  relay: { transport: 'stdio', executable: launcher, executableSha256: digest, handle: 'synthetic_turn_only' },
  instructions: 'SYNTHETIC_ALLOWLISTED_STATIC_INSTRUCTIONS' });

describe('host-owned SDK private worker launch', () => {
  it('runs a real owned child with a clean home/cwd and excludes inherited/operator environment, memory and resume', async () => {
    const launch = plan();
    const config: Config = { cwd: root, cwdBase: root, baseDir: root, dataDir: root, botToken: 'SYNTHETIC_TOKEN',
      apiUrl: 'https://synthetic.invalid', cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' },
      rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
      maxResponseChars: 5000, dispatchTimeoutMs: 10000, sdk: { env: { SYNTHETIC_AMBIENT_SECRET: 'fixture' },
      codexApiKey: 'SYNTHETIC_LEGACY_PROVIDER_KEY', codexBaseUrl: 'https://legacy-synthetic.invalid',
      systemPrompt: 'LEGACY_STATIC_TEXT', additionalDirectories: [root], sandboxMode: 'danger-full-access',
      networkAccessEnabled: true, webSearchEnabled: true, privateDiagnostics: false,
      recovery: { enabled: true, maxAttempts: 2 } } };
    const owned: ManagedExecution[] = [];
    try {
      let answer = '';
      for await (const event of queryAgentEvents('SYNTHETIC_CURRENT_INPUT', config, undefined, undefined, {
        privateWorker: launch, privateMemoryContext: 'LEGACY_MEMORY' as never,
        onManagedExecution: execution => owned.push(execution),
      })) if (event.kind === 'message') answer = event.text;
      const report = JSON.parse(answer) as { keys: string[]; args: string[]; home: string; cwd: string; initialCwd: string; input: string };
      expect(report.home).toBe(launch.codexHome); expect(report.cwd).toBe(realpathSync(launch.workdir));
      expect(report.initialCwd).toBe(realpathSync(launch.workdir));
      expect(report.keys).not.toContain('SYNTHETIC_AMBIENT_SECRET');
      expect(report.keys).not.toContain('CODEX_API_KEY');
      expect(report.args.join(' ')).not.toContain('legacy-synthetic.invalid');
      for (const key of ['OCTO_TOKEN', 'OCTO_TASK_TOKEN', 'OCTO_BOT_TOKEN', 'CODEX_CHANNEL_EXECUTION_DIR', 'CODEX_CHANNEL_EXECUTION_TOKEN']) {
        expect(report.keys).not.toContain(key);
      }
      expect(report.input).not.toContain('LEGACY_MEMORY'); expect(report.args).not.toContain('resume');
      expect(report.args.join(' ')).toContain('mcp_servers='); expect(report.args).not.toContain('--add-dir');
      expect(readFileSync(join(launch.workdir, 'AGENTS.md'), 'utf8')).toBe(launch.instructions);
      await expect(async () => {
        for await (const event of queryAgentEvents('again', config, undefined, undefined,
          { privateWorker: launch, resume: 'old', onManagedExecution: execution => owned.push(execution) })) void event;
      }).rejects.toThrow();
    } finally {
      for (const execution of owned) { await execution.waitForStopped(5000); execution.dispose(); }
    }
  });

  it.each(['stdio', 'http'] as const)('checks the locked native CLI lists only the explicit %s relay in the clean namespace', async transport => {
    const launch = transport === 'stdio' ? plan() : preparePrivateWorker({ root, launcher, launcherSha256: digest,
      relay: { transport: 'http', url: 'https://synthetic.invalid/mcp', handle: 'synthetic_turn_only' }, instructions: 'STATIC' });
    const codex = createRequire(new URL('../../node_modules/@openai/codex-sdk/package.json', import.meta.url)).resolve('@openai/codex/bin/codex.js');
    const args = [codex, 'mcp', 'list', '--json', ...launch.configOverrides.flatMap(value => ['--config', value])];
    const { stdout } = await exec(process.execPath, args, { cwd: launch.workdir, env: { ...launch.env }, timeout: 10000 });
    const servers = JSON.parse(stdout) as { name: string }[];
    expect(servers.map(server => server.name)).toEqual(['octo']);
    // This verifies one local distribution's config loading only. It does not
    // prove distinct-UID/network/mount isolation or other supported platforms.
  });

  it('rejects a changed executable and insecure HTTP relay before constructing a launch', () => {
    expect(() => preparePrivateWorker({ root, launcher, launcherSha256: '0'.repeat(64),
      relay: { transport: 'http', url: 'https://synthetic.invalid/mcp', handle: 'turn' }, instructions: '' })).toThrow('executable');
    expect(() => preparePrivateWorker({ root, launcher, launcherSha256: digest,
      relay: { transport: 'http', url: 'http://synthetic.invalid/mcp', handle: 'turn' }, instructions: '' })).toThrow('URL');
  });

  it('enforces OS-level sandbox containment against same-UID host secret paths while allowing generation workdir/codexHome', async () => {
    chmodSync(root, 0o700);
    const coordinatorDir = join(root, 'coordinator-secrets');
    const hostDataDir = join(root, 'host-data');
    mkdirSync(coordinatorDir, { mode: 0o700 });
    mkdirSync(hostDataDir, { mode: 0o700 });
    const secretKeyFile = join(coordinatorDir, 'control.key');
    const secretTokenFile = join(hostDataDir, 'bot-token.txt');
    const outsideWriteTarget = join(root, 'outside-escape.txt');
    writeFileSync(secretKeyFile, 'COORD_PRIVATE_KEY', { mode: 0o600 });
    writeFileSync(secretTokenFile, 'HOST_BOT_TOKEN', { mode: 0o600 });

    const probeExecutable = join(root, 'sandbox-probe-worker');
    const probeCode = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.readFileSync(0, 'utf8');
const tryRead = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return 'ERR:' + e.code; } };
const tryWrite = (p, v) => { try { fs.writeFileSync(p, v); return 'OK'; } catch (e) { return 'ERR:' + e.code; } };
const report = {
  readCoordSecret: tryRead(${JSON.stringify(secretKeyFile)}),
  readHostSecret: tryRead(${JSON.stringify(secretTokenFile)}),
  writeOutside: tryWrite(${JSON.stringify(outsideWriteTarget)}, 'escape'),
  writeWorkdir: tryWrite(path.join(process.cwd(), 'allowed-work.txt'), 'work-ok'),
  writeCodexHome: tryWrite(path.join(process.env.CODEX_HOME, 'allowed-home.txt'), 'home-ok'),
  agentsMd: tryRead(path.join(process.cwd(), 'AGENTS.md')),
};
console.log(JSON.stringify({ type: 'thread.started', thread_id: '22222222-2222-4222-8222-222222222222' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'probe', type: 'agent_message', text: JSON.stringify(report) } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;
    writeFileSync(probeExecutable, probeCode, { mode: 0o700 });
    const probeSha256 = createHash('sha256').update(probeCode).digest('hex');

    const isolated = createIsolatingWorkerLauncher({
      root,
      targetExecutable: probeExecutable,
      targetExecutableSha256: probeSha256,
      deniedPaths: [root, coordinatorDir, hostDataDir],
      allowNetwork: false,
    });
    const hostCaPath = join(coordinatorDir, 'relay-ca.pem');
    writeFileSync(hostCaPath, '-----BEGIN CERTIFICATE-----\nU1lOVEhFVElDX0NB\n-----END CERTIFICATE-----\n', { mode: 0o600 });
    const launch = preparePrivateWorker({
      root,
      launcher: isolated.launcher,
      launcherSha256: isolated.launcherSha256,
      relay: {
        transport: 'http',
        url: 'https://synthetic.invalid/mcp',
        handle: 'synthetic_turn_only',
        tls: {
          ca_file: hostCaPath,
          cert_sha256: 'e'.repeat(64),
          server_name: 'localhost',
        },
      },
      instructions: 'ISOLATED_WORKER_INSTRUCTIONS',
    });
    expect(launch.relayCaPath).toBe(join(launch.codexHome, 'relay-ca.pem'));
    expect(launch.env.SSL_CERT_FILE).toBe(launch.relayCaPath);
    expect(launch.env.NODE_EXTRA_CA_CERTS).toBe(launch.relayCaPath);
    expect(launch.relayTls).toEqual({
      ca_file: launch.relayCaPath,
      cert_sha256: 'e'.repeat(64),
      server_name: 'localhost',
    });

    const config: Config = {
      cwd: root, cwdBase: root, baseDir: root, dataDir: hostDataDir, botToken: 'SYNTHETIC_TOKEN',
      apiUrl: 'https://synthetic.invalid', cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' },
      rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
      maxResponseChars: 5000, dispatchTimeoutMs: 10000, sdk: {},
    };
    const owned: ManagedExecution[] = [];
    try {
      let answer = '';
      for await (const event of queryAgentEvents('PROBE_SANDBOX', config, undefined, undefined, {
        privateWorker: launch,
        onManagedExecution: execution => owned.push(execution),
      })) if (event.kind === 'message') answer = event.text;
      const report = JSON.parse(answer) as Record<string, string>;
      expect(report.readCoordSecret).toMatch(/^ERR:(EPERM|EACCES|ENOENT)$/);
      expect(report.readHostSecret).toMatch(/^ERR:(EPERM|EACCES|ENOENT)$/);
      expect(report.writeOutside).toMatch(/^ERR:(EPERM|EACCES|EROFS)$/);
      expect(report.writeWorkdir).toBe('OK');
      expect(report.writeCodexHome).toBe('OK');
      expect(report.agentsMd).toBe('ISOLATED_WORKER_INSTRUCTIONS');
    } finally {
      for (const execution of owned) { await execution.waitForStopped(5000); execution.dispose(); }
    }
  });

  it('permits same-generation resumeThread only when verifiedResume matches and reuses generation workspace', async () => {
    chmodSync(root, 0o700);
    const first = preparePrivateWorker({
      root, launcher, launcherSha256: digest,
      relay: { transport: 'stdio', executable: launcher, executableSha256: digest, handle: 'turn_1' },
      instructions: 'GEN1_TURN1',
    });
    const verified = preparePrivateWorker({
      root, launcher, launcherSha256: digest,
      relay: { transport: 'stdio', executable: launcher, executableSha256: digest, handle: 'turn_2' },
      instructions: 'GEN1_TURN2',
      verifiedResume: {
        generation: 'a'.repeat(32),
        turnId: 'b'.repeat(32),
        sessionId: '11111111-1111-4111-8111-111111111111',
        scopeIncarnation: 'c'.repeat(32),
        contextEpoch: '1',
        contributorCount: 2,
        workdir: first.workdir,
        codexHome: first.codexHome,
      },
    });
    expect(verified.workdir).toBe(first.workdir);
    expect(verified.codexHome).toBe(first.codexHome);
    expect(readFileSync(join(verified.workdir, 'AGENTS.md'), 'utf8')).toBe('GEN1_TURN2');

    const config: Config = {
      cwd: root, cwdBase: root, baseDir: root, dataDir: root, botToken: 'SYNTHETIC_TOKEN',
      apiUrl: 'https://synthetic.invalid', cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' },
      rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
      maxResponseChars: 5000, dispatchTimeoutMs: 10000, sdk: {},
    };
    const owned: ManagedExecution[] = [];
    try {
      let answer = '';
      for await (const event of queryAgentEvents('RESUMED_INPUT', config, undefined, undefined, {
        privateWorker: verified,
        resume: '11111111-1111-4111-8111-111111111111',
        onManagedExecution: execution => owned.push(execution),
      })) if (event.kind === 'message') answer = event.text;
      const report = JSON.parse(answer) as { args: string[]; home: string; cwd: string };
      expect(report.args).toContain('resume');
      expect(report.args).toContain('11111111-1111-4111-8111-111111111111');
      expect(report.home).toBe(first.codexHome);

      await expect(async () => {
        for await (const event of queryAgentEvents('MISMATCHED_RESUME', config, undefined, undefined, {
          privateWorker: verified,
          resume: '99999999-9999-4999-8999-999999999999',
          onManagedExecution: execution => owned.push(execution),
        })) void event;
      }).rejects.toThrow();
    } finally {
      for (const execution of owned) { await execution.waitForStopped(5000); execution.dispose(); }
    }
  });

  it('includes --unshare-net in linux-bwrap launcher when allowNetwork is false and omits it when allowNetwork is true', () => {
    chmodSync(root, 0o700);
    const fakeBwrap = join(root, 'fake-bwrap');
    writeFileSync(fakeBwrap, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const noNet = createIsolatingWorkerLauncher({
      root,
      targetExecutable: launcher,
      targetExecutableSha256: digest,
      deniedPaths: [root],
      allowNetwork: false,
      platform: 'linux',
      sandboxExecutable: fakeBwrap,
    });
    expect(noNet.backend).toBe('linux-bwrap');
    const noNetWrapper = readFileSync(noNet.launcher, 'utf8');
    expect(noNetWrapper).toContain('"--unshare-net"');

    const withNet = createIsolatingWorkerLauncher({
      root,
      targetExecutable: launcher,
      targetExecutableSha256: digest,
      deniedPaths: [root],
      allowNetwork: true,
      platform: 'linux',
      sandboxExecutable: fakeBwrap,
    });
    const withNetWrapper = readFileSync(withNet.launcher, 'utf8');
    expect(withNetWrapper).not.toContain('"--unshare-net"');
  });

  it('verifies HTTP relay ca_sha256 and peer leaf certificate pin over TLS 1.3 and fails closed on mismatch', async () => {
    chmodSync(root, 0o700);
    const keyPath = join(root, 'relay-key.pem');
    const certPath = join(root, 'relay-cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    chmodSync(keyPath, 0o600);
    chmodSync(certPath, 0o600);
    const certPem = readFileSync(certPath);
    const keyPem = readFileSync(keyPath);
    const caSha256 = createHash('sha256').update(certPem).digest('hex');
    const peerSha256 = createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex');

    // Wrong ca_sha256 is rejected during preparePrivateWorker before any launch
    expect(() => preparePrivateWorker({
      root,
      launcher,
      launcherSha256: digest,
      relay: {
        transport: 'http',
        url: 'https://127.0.0.1:443/mcp',
        handle: 'turn_pin_test',
        caSha256: 'f'.repeat(64),
        peerSha256,
        tls: { ca_file: certPath, cert_sha256: peerSha256, server_name: 'localhost' },
      },
      instructions: 'PIN_TEST',
    })).toThrow('CA digest mismatch');

    let responseMode: 'ok' | 'overflow-cl' | 'overflow-stream' = 'ok';
    const httpsServer = createHttpsServer({ key: keyPem, cert: certPem, minVersion: 'TLSv1.3' }, (_req, res) => {
      if (responseMode === 'overflow-cl') {
        const big = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { pad: 'x'.repeat(2048) } });
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-octo-acquisition-budget-bytes': '512',
          'content-length': String(Buffer.byteLength(big)),
        });
        res.end(big);
        return;
      }
      if (responseMode === 'overflow-stream') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-octo-acquisition-budget-bytes': '512',
        });
        res.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { pad: 'y'.repeat(1024) } }));
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-octo-acquisition-budget-bytes': '512',
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    });
    httpsServer.listen(0, '127.0.0.1');
    await once(httpsServer, 'listening');
    const addr = httpsServer.address();
    if (!addr || typeof addr === 'string') throw new Error('No address');
    const relayUrl = `https://127.0.0.1:${addr.port}/mcp`;
    const bearer = 'a'.repeat(64);

    const otherKeyPath = join(root, 'other-ca-key.pem');
    const otherCertPath = join(root, 'other-ca-cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', otherKeyPath, '-out', otherCertPath, '-days', '1',
      '-subj', '/CN=other-ca', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    chmodSync(otherKeyPath, 0o600);
    chmodSync(otherCertPath, 0o600);
    const otherCaBytes = readFileSync(otherCertPath);
    const otherCaSha256 = createHash('sha256').update(otherCaBytes).digest('hex');

    try {
      const validLaunch = preparePrivateWorker({
        root,
        launcher,
        launcherSha256: digest,
        relay: {
          transport: 'http',
          url: relayUrl,
          handle: bearer,
          caSha256,
          peerSha256,
          tls: { ca_file: certPath, ca_sha256: caSha256, cert_sha256: peerSha256, server_name: 'localhost' },
        },
        instructions: 'PIN_OK',
      });
      await expect(verifyHttpRelayTlsPin(validLaunch)).resolves.toBeUndefined();
      // Actual receiving connection with custom CA + leaf pin succeeds
      const rpcRes = await postHttpTurnRelay(validLaunch, bearer, { jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(rpcRes).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });

      // Wrong leaf certificate pin on actual receiving connection fails closed
      const wrongPeerLaunch = preparePrivateWorker({
        root,
        launcher,
        launcherSha256: digest,
        relay: {
          transport: 'http',
          url: relayUrl,
          handle: bearer,
          caSha256,
          peerSha256: 'e'.repeat(64),
          tls: { ca_file: certPath, ca_sha256: caSha256, cert_sha256: 'e'.repeat(64), server_name: 'localhost' },
        },
        instructions: 'PIN_WRONG_PEER',
      });
      await expect(verifyHttpRelayTlsPin(wrongPeerLaunch)).rejects.toThrow('peer certificate digest mismatch');
      await expect(postHttpTurnRelay(wrongPeerLaunch, bearer, { jsonrpc: '2.0', id: 1, method: 'ping' }))
        .rejects.toThrow('peer certificate digest mismatch');

      // Wrong CA on actual receiving connection fails closed
      const wrongCaLaunch = preparePrivateWorker({
        root,
        launcher,
        launcherSha256: digest,
        relay: {
          transport: 'http',
          url: relayUrl,
          handle: bearer,
          caSha256: otherCaSha256,
          peerSha256,
          tls: { ca_file: otherCertPath, ca_sha256: otherCaSha256, cert_sha256: peerSha256, server_name: 'localhost' },
        },
        instructions: 'PIN_WRONG_CA',
      });
      await expect(postHttpTurnRelay(wrongCaLaunch, bearer, { jsonrpc: '2.0', id: 1, method: 'ping' }))
        .rejects.toThrow('Turn relay TLS verification failed');

      // Acquisition budget overflow on actual receiving connection (Content-Length & streaming) fails closed
      responseMode = 'overflow-cl';
      await expect(postHttpTurnRelay(validLaunch, bearer, { jsonrpc: '2.0', id: 1, method: 'ping' }))
        .rejects.toThrow('RESPONSE_BUDGET_EXCEEDED');
      responseMode = 'overflow-stream';
      await expect(postHttpTurnRelay(validLaunch, bearer, { jsonrpc: '2.0', id: 1, method: 'ping' }))
        .rejects.toThrow('RESPONSE_BUDGET_EXCEEDED');
    } finally {
      httpsServer.closeAllConnections();
      await new Promise<void>(resolve => httpsServer.close(() => resolve()));
    }
  });
});
