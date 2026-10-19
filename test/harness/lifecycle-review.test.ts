import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitHostedPid, stopOwnedHost, RealEnv } from '../real-binary/harness.js';
import { JsonlRpcClient } from './jsonl-client.js';
import { redactInstructions } from './mock-responses/server.mjs';

describe('review lifecycle and evidence', () => {
  it.skipIf(process.platform === 'win32')('RC-L1: startup timeout reaps its owned host before rejecting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev01-host-timeout-'));
    const host = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    try {
      await expect(awaitHostedPid(host, join(dir, 'never-created'), 100)).rejects.toThrow(/did not start/);
      expect(host.signalCode).toBe('SIGKILL');
      expect(() => process.kill(host.pid!, 0)).toThrow();
    } finally { await stopOwnedHost(host); rmSync(dir, { recursive: true, force: true }); }
  });
  it('RC-L2: an early stderr escape is retained after more than 64KB of output', async () => {
    const c = JsonlRpcClient.spawn(process.execPath, ['-e', 'process.stderr.write("https://outside.invalid/\\n"+"x".repeat(70000));']);
    await c.exited;
    await new Promise(resolve => setImmediate(resolve));
    expect(c.stderr).toContain('https://outside.invalid/');
    const env = RealEnv.create('stderr-review');
    try { expect(() => env.evidence({ label: 'probe', transcript: [], stderr: c.stderr })).toThrow(/network escape/); }
    finally { await env.finish(); }
  });
  it('RC-L3: stdout JSON-RPC transcript is subject to the same escape guard', async () => {
    const env = RealEnv.create('stdout-review');
    try { expect(() => env.evidence({ label: 'probe', transcript: [{ dir: 'in', at: 1, message: { method: 'warning', params: { url: 'https://outside.invalid' } } }], stderr: '' })).toThrow(/network escape/); }
    finally { await env.finish(); }
  });
  it('RC-L4: instruction prose is replaced with a hash while protocol fields survive', () => {
    const data = redactInstructions({ body: { instructions: 'vendor prose', input: 'synthetic input' }, payload: { base_instructions: { text: 'vendor prose' } } });
    expect(JSON.stringify(data)).not.toContain('vendor prose');
    expect(data.body.input).toBe('synthetic input');
    expect(data.body.instructions.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
