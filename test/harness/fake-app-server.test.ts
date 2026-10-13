/**
 * Scripted fake App Server (R8 §3.3.4 rule 7, §10.1 layer 2). DEV-03/04 drive
 * their client and runtime against it; DEV-01 proves the fake itself: protocol
 * parity with the pinned binary for the subset it implements, every runtime.*
 * fault point, steering detection and unanswered-server-request accounting.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlRpcClient } from './jsonl-client.js';
import { normalizeTranscript } from './app-server-normalize.js';

const FAKE = fileURLToPath(new URL('./mock-app-server/fake-app-server.mjs', import.meta.url));
const clients: JsonlRpcClient[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function spawnFake(scenario: unknown, faults: Array<{ point: string; times?: number }> = []) {
  const dir = mkdtempSync(join(tmpdir(), 'dev01-fake-as-'));
  dirs.push(dir);
  const log = join(dir, 'fake.jsonl');
  const client = JsonlRpcClient.spawn(process.execPath, [FAKE], {
    env: { ...process.env, FAKE_AS_SCENARIO: JSON.stringify(scenario), FAKE_AS_FAULTS: JSON.stringify(faults), FAKE_AS_LOG: log },
  });
  clients.push(client);
  const report = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; [k: string]: unknown });
  return { client, report };
}

async function ready(c: JsonlRpcClient) {
  await c.request('initialize', { clientInfo: { name: 'codex_sdk_ts', title: null, version: '0.0.0' }, capabilities: { experimentalApi: true } });
  c.notify('initialized', {});
  const t = await c.request('thread/start', { cwd: '/tmp', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false }) as { thread: { id: string } };
  return t.thread.id;
}

describe('fake App Server', () => {
  it('FAS-01 (SB-01 parity): rejects requests before initialize and a second initialize with -32600', async () => {
    const { client } = spawnFake({ turns: [] });
    await expect(client.request('thread/start', {})).rejects.toMatchObject({ code: -32600, message: 'Not initialized' });
    await client.request('initialize', { clientInfo: { name: 'x', version: '1' } });
    await expect(client.request('initialize', { clientInfo: { name: 'x', version: '1' } })).rejects.toMatchObject({ code: -32600, message: 'Already initialized' });
  });

  it('FAS-02: a basic turn has the same normalized notification shape as the pinned 0.142.3 binary capture', async () => {
    const { client } = spawnFake({ turns: [{ text: 'Hello from mock' }] });
    const tid = await ready(client);
    await client.request('turn/start', { threadId: tid, input: [{ type: 'text', text: 'hi', text_elements: [] }], cwd: '/tmp', approvalPolicy: 'never', effort: 'low' });
    await client.waitForNotification((n) => n.method === 'turn/completed');
    await client.request('thread/unsubscribe', { threadId: tid });
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/app-server/0.142.3/basic-turn.normalized.json', import.meta.url), 'utf8')) as { pin: string; sequence: string[] };
    expect(fixture.pin).toBe('0.142.3');
    expect(normalizeTranscript(client.transcript)).toEqual(fixture.sequence);
  });

  it('FAS-03: a turn/start on an active thread is recorded as a steering violation', async () => {
    const { client, report } = spawnFake({ turns: [{ text: 'slow', delayMs: 400 }, { text: 'second' }] });
    const tid = await ready(client);
    const input = [{ type: 'text', text: 'hi', text_elements: [] }];
    await client.request('turn/start', { threadId: tid, input, cwd: '/tmp', approvalPolicy: 'never', effort: 'low' });
    await client.request('turn/start', { threadId: tid, input, cwd: '/tmp', approvalPolicy: 'never', effort: 'low' }).catch(() => undefined);
    await client.waitForNotification((n) => n.method === 'turn/completed');
    expect(report().filter((r) => r.kind === 'violation').map((r) => r.code)).toContain('steering');
  });

  it('FAS-04: runtime.dropInterruptResponse withholds the interrupt response but still terminates the turn', async () => {
    const { client } = spawnFake({ turns: [{ hang: true }] }, [{ point: 'runtime.dropInterruptResponse' }]);
    const tid = await ready(client);
    const t = await client.request('turn/start', { threadId: tid, input: [{ type: 'text', text: 'x', text_elements: [] }] }) as { turn: { id: string } };
    const pending = client.request('turn/interrupt', { threadId: tid, turnId: t.turn.id }, { timeoutMs: 600 });
    const done = await client.waitForNotification((n) => n.method === 'turn/completed');
    expect((done.params as { turn: { status: string } }).turn.status).toBe('interrupted');
    await expect(pending).rejects.toThrow(/timed out/);
  });

  it('FAS-05: runtime.dropTurnCompleted answers the interrupt but never emits turn/completed', async () => {
    const { client } = spawnFake({ turns: [{ hang: true }] }, [{ point: 'runtime.dropTurnCompleted' }]);
    const tid = await ready(client);
    const t = await client.request('turn/start', { threadId: tid, input: [{ type: 'text', text: 'x', text_elements: [] }] }) as { turn: { id: string } };
    await expect(client.request('turn/interrupt', { threadId: tid, turnId: t.turn.id })).resolves.toEqual({});
    await expect(client.waitForNotification((n) => n.method === 'turn/completed', 500)).rejects.toThrow(/timed out/);
  });

  it('FAS-06: runtime.failUnsubscribe makes thread/unsubscribe fail', async () => {
    const { client } = spawnFake({ turns: [] }, [{ point: 'runtime.failUnsubscribe' }]);
    const tid = await ready(client);
    await expect(client.request('thread/unsubscribe', { threadId: tid })).rejects.toMatchObject({ code: -32603 });
  });

  it('FAS-07: runtime.killChild exits the process mid-turn with no terminal event', async () => {
    const { client } = spawnFake({ turns: [{ text: 'never', delayMs: 2_000 }] }, [{ point: 'runtime.killChild' }]);
    const tid = await ready(client);
    await client.request('turn/start', { threadId: tid, input: [{ type: 'text', text: 'x', text_elements: [] }] });
    const exit = await client.exited;
    expect(exit.code).not.toBe(0);
    expect(client.transcript.some((e) => e.dir === 'in' && e.message.method === 'turn/completed')).toBe(false);
  });

  it('FAS-08: server requests are tracked; an unanswered one is reported as a violation at shutdown', async () => {
    const { client, report } = spawnFake({ turns: [{ serverRequest: { method: 'item/commandExecution/requestApproval', params: { itemId: 'i1' } }, text: 'after' }] });
    client.onServerRequest = () => undefined; // deliberately never answer
    const tid = await ready(client);
    await client.request('turn/start', { threadId: tid, input: [{ type: 'text', text: 'x', text_elements: [] }] });
    await client.waitForServerRequest((r) => r.method === 'item/commandExecution/requestApproval');
    await client.close();
    expect(report().filter((r) => r.kind === 'violation').map((r) => r.code)).toContain('unanswered-server-request');
  });

  it('FAS-09: an answered server request lets the scripted turn complete and is not a violation', async () => {
    const { client, report } = spawnFake({ turns: [{ serverRequest: { method: 'item/commandExecution/requestApproval', params: { itemId: 'i1' } }, text: 'after' }] });
    client.onServerRequest = (r) => ({ error: { code: -32000, message: `${r.method} is not supported in exec mode for thread \`x\`` } });
    const tid = await ready(client);
    await client.request('turn/start', { threadId: tid, input: [{ type: 'text', text: 'x', text_elements: [] }] });
    await client.waitForNotification((n) => n.method === 'turn/completed');
    await client.close();
    expect(report().filter((r) => r.kind === 'violation')).toEqual([]);
  });

  it('FAS-10: unknown fault point names are rejected at start-up (typo guard)', async () => {
    const { client } = spawnFake({ turns: [] }, [{ point: 'runtime.dropTurnComplete' }]);
    const exit = await client.exited;
    expect(exit.code).toBe(2);
  });
});
