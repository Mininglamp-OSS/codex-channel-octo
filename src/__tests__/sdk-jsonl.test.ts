import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Codex } from '@openai/codex-sdk';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSdkJsonlParseError, summarizeAgentError } from '../agent-errors.js';
import { escapeJsonlSeparators } from '../codex-jsonl-proxy.mjs';
import { resolveJsonlProxyPath } from '../jsonl-proxy-path.js';

let root: string;
const fixture = fileURLToPath(new URL('./fixtures/jsonl-cli.mjs', import.meta.url));
const proxy = fileURLToPath(new URL('./fixtures/jsonl-proxy.mjs', import.meta.url));
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sdk-jsonl-')); chmodSync(fixture, 0o755); chmodSync(proxy, 0o755); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('real SDK JSONL transport with a synthetic CLI', () => {
  it('launches the selected production proxy with no node on PATH', () => {
    const entry = fileURLToPath(new URL('../codex-jsonl-proxy.mjs', import.meta.url));
    const selected = resolveJsonlProxyPath(entry)!;
    expect(execFileSync(selected, ['--version'], { env: { ...process.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000 }))
      .toMatch(/^codex-cli \d+\.\d+\.\d+/);
  });
  it('terminates a backpressured proxy and an uncooperative child without downstream drain', async () => {
    const pidFile = join(root, 'child-pid');
    const entry = fileURLToPath(new URL('./fixtures/jsonl-cancel-proxy.mjs', import.meta.url));
    const child = spawn(process.execPath, [entry], { env: { ...process.env, JSONL_CHILD_PID_FILE: pidFile }, stdio: ['pipe', 'pipe', 'pipe'] });
    let innerPid: number | undefined;
    const completion = new Promise((resolve) => child.once('exit', resolve));
    child.stdout.pause();
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(pidFile)).toBe(true);
      innerPid = Number(readFileSync(pidFile, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      child.kill('SIGTERM');
      await Promise.race([completion, new Promise((_, reject) => setTimeout(() => reject(new Error('proxy cancellation timed out')), 4000))]);
      expect(() => process.kill(innerPid!, 0)).toThrow();
    } finally {
      child.kill('SIGKILL');
      if (innerPid) { try { process.kill(innerPid, 'SIGKILL'); } catch { innerPid = undefined; } }
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
    }
  }, 7000);
  it('flushes all buffered records on natural signal exit through a slow reader', async () => {
    const entry = fileURLToPath(new URL('./fixtures/jsonl-cancel-proxy.mjs', import.meta.url));
    const child = spawn(process.execPath, [entry], { env: { ...process.env, JSONL_CHILD_PID_FILE: join(root, 'pid'), JSONL_FIXTURE_MODE: 'signal-flush' } });
    const completion = new Promise((resolve) => child.once('exit', resolve));
    let output = '';
    try {
      for await (const chunk of child.stdout) {
        output += chunk.toString();
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      await completion;
      const records = output.trim().split('\n').map((line) => JSON.parse(line));
      expect(records).toHaveLength(3000);
      expect(records.map((record) => record.index)).toEqual(Array.from({ length: 3000 }, (_, index) => index));
    } finally { child.kill('SIGKILL'); child.stdin.destroy(); child.stderr.destroy(); }
  }, 10000);
  it('escapes LS/PS deterministically without changing decoded data or existing escape sequences', () => {
    const original = { text: 'slash\\literal\\u2028\u2028\u2029\r\n' };
    const serialized = escapeJsonlSeparators(JSON.stringify(original));
    expect(serialized).not.toMatch(/[\u2028\u2029]/u);
    expect(serialized).toContain('\\u2028');
    expect(JSON.parse(serialized)).toEqual(original);
  });
  it('boots the real installed CLI through the entry point and through a symlink', () => {
    const entry = fileURLToPath(new URL('../codex-jsonl-proxy.mjs', import.meta.url));
    const link = join(root, 'proxy-link.mjs');
    symlinkSync(entry, link);
    for (const file of [entry, link]) {
      expect(execFileSync(process.execPath, [file, '--version'], { encoding: 'utf8', timeout: 10_000 }))
        .toMatch(/^codex-cli \d+\.\d+\.\d+/);
    }
  });
  it('reports bootstrap resolution failure without exposing paths or raw diagnostics', () => {
    const entry = join(root, 'isolated-proxy.mjs');
    copyFileSync(fileURLToPath(new URL('../codex-jsonl-proxy.mjs', import.meta.url)), entry);
    const child = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8', timeout: 10_000 });
    expect(child.status).toBe(1);
    expect(JSON.parse(child.stdout).message).toContain('CODEX_JSONL_PROXY_BOOTSTRAP_FAILURE');
    expect(child.stderr).toBe('');
    expect(child.stdout).not.toContain(root);
  });
  it('accepts large valid JSON containing Unicode separators and split UTF-8 chunks', async () => {
    const sdk = new Codex({ codexPathOverride: proxy, env: { PATH: process.env.PATH!, JSONL_FIXTURE_MODE: 'valid' } });
    const { events } = await sdk.startThread().runStreamed('synthetic prompt');
    const types: string[] = [];
    for await (const event of events) {
      types.push(event.type);
      if (event.type === 'item.completed' && event.item.type === 'command_execution') {
        expect(event.item.aggregated_output).toBe('synthetic\r\n\v\f\u0085\u2028\u2029'.repeat(20_000));
      }
    }
    expect(types).toEqual(['thread.started', 'item.completed', 'turn.completed']);
  });
  it('detects the active runtime’s Unicode readline behavior without real private content', async () => {
    const { createInterface } = await import('node:readline');
    const { Readable } = await import('node:stream');
    const text = JSON.stringify({ content: 'synthetic\u2028\u2029' });
    const records: string[] = [];
    for await (const line of createInterface({ input: Readable.from([text + '\n']), crlfDelay: Infinity })) records.push(line);
    if (process.version === 'v24.10.0') expect(records).toHaveLength(3);
    expect(records.join('')).not.toContain('\n');
    if (records.length > 1) expect(() => JSON.parse(records[0])).toThrow(SyntaxError);
    else expect(JSON.parse(records[0]).content).toBe('synthetic\u2028\u2029');
  });
  it('reproduces a truncated record error and confirms SDK cleanup terminates its child', async () => {
    const terminated = join(root, 'terminated');
    const sdk = new Codex({ codexPathOverride: proxy, env: { PATH: process.env.PATH!,
      JSONL_FIXTURE_MODE: 'malformed', JSONL_TERMINATED_FILE: terminated } });
    const { events } = await sdk.startThread().runStreamed('synthetic prompt');
    let failure: unknown;
    try { for await (const event of events) void event; } catch (error) { failure = error; }
    expect(isSdkJsonlParseError(failure)).toBe(true);
    expect(summarizeAgentError(failure)).toBe('Codex SDK JSONL parse failure (incomplete-json)');
    for (let attempt = 0; attempt < 100 && !existsSync(terminated); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(terminated)).toBe(true);
  });
});
