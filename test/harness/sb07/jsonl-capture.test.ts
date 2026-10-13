/**
 * SB07-F1 (A-R8-SB07-01): the test harness JSONL client answers an exec-mode
 * command approval with the byte-exact pinned 0.142.3 parity reply, and its
 * raw transcript records outbound reply bytes, timestamps and the process
 * incarnation. Exercised against fresh child processes (the scripted fake
 * App Server), not by calling the oracle on itself.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlRpcClient, type TranscriptEntry } from '../jsonl-client.js';
import { checkSb07RejectionPath } from './oracle.js';

const FAKE = fileURLToPath(new URL('../mock-app-server/fake-app-server.mjs', import.meta.url));
const clients: JsonlRpcClient[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function spawnFake(scenario: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'dev01-sb07-cap-'));
  dirs.push(dir);
  const log = join(dir, 'fake.jsonl');
  const client = JsonlRpcClient.spawn(process.execPath, [FAKE], { env: { ...process.env, FAKE_AS_SCENARIO: JSON.stringify(scenario), FAKE_AS_LOG: log } });
  clients.push(client);
  const report = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; [k: string]: unknown });
  return { client, report };
}

async function runOne(client: JsonlRpcClient) {
  await client.request('initialize', { clientInfo: { name: 'codex_sdk_ts', title: null, version: '0.0.0' }, capabilities: { experimentalApi: true } });
  client.notify('initialized', {});
  const t = await client.request('thread/start', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'read-only', ephemeral: false }) as { thread: { id: string } };
  const turn = await client.request('turn/start', { threadId: t.thread.id, input: [{ type: 'text', text: 'x', text_elements: [] }] }) as { turn: { id: string } };
  await client.waitForNotification((n) => n.method === 'turn/completed' && (n.params as { turn: { id: string } }).turn.id === turn.turn.id, 5_000);
  return { threadId: t.thread.id, turnId: turn.turn.id };
}

const parity = (threadId: string) => `command execution approval is not supported in exec mode for thread \`${threadId}\``;

describe('SB07-F1 harness capture', () => {
  it('SB07-F1-CAP-01: the default answer to item/commandExecution/requestApproval is the exact exec-mode literal with code -32000', () => {
    const { client } = spawnFake({ turns: [] });
    const answer = client.onServerRequest({ id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: 'th-1', turnId: 'tu-1', itemId: 'it-1' } });
    expect(answer).toEqual({ error: { code: -32000, message: 'command execution approval is not supported in exec mode for thread `th-1`' } });
  });

  it('SB07-F1-CAP-02: outbound replies are captured with exact bytes, timestamp and process incarnation; id 0 keeps its numeric type', async () => {
    const { client } = spawnFake({ turns: [{ serverRequest: { method: 'item/commandExecution/requestApproval', params: { itemId: 'i1' } }, text: 'after' }] });
    const { threadId } = await runOne(client);
    const c = client as JsonlRpcClient & { incarnation?: string };
    expect(typeof c.incarnation).toBe('string');
    const req = client.transcript.find((e) => e.dir === 'in' && e.message.method === 'item/commandExecution/requestApproval')!;
    const reply = client.transcript.filter((e) => e.dir === 'out' && e.message.method === undefined && e.message.id === 0);
    expect(reply).toHaveLength(1);
    const r = reply[0] as TranscriptEntry & { raw?: string; incarnation?: string };
    expect(r.raw).toBe(`{"id":0,"error":{"code":-32000,"message":${JSON.stringify(parity(threadId))}}}`);
    expect(r.incarnation).toBe(c.incarnation);
    expect((req as { incarnation?: string }).incarnation).toBe(c.incarnation);
    expect((req as { raw?: string }).raw).toBe(JSON.stringify(req.message));
    expect(typeof r.at).toBe('number');
    expect(r.at - req.at).toBeGreaterThanOrEqual(0);
    expect(r.at - req.at).toBeLessThanOrEqual(5_000);
  });

  it('SB07-F1-CAP-03: each spawned process gets a distinct incarnation and every entry carries its own', async () => {
    const a = spawnFake({ turns: [] }).client as JsonlRpcClient & { incarnation?: string };
    const b = spawnFake({ turns: [] }).client as JsonlRpcClient & { incarnation?: string };
    await a.request('initialize', { clientInfo: { name: 'x', version: '1' } });
    await b.request('initialize', { clientInfo: { name: 'x', version: '1' } });
    expect(a.incarnation).toBeDefined();
    expect(a.incarnation).not.toBe(b.incarnation);
    for (const c of [a, b]) for (const e of c.transcript) expect((e as { incarnation?: string }).incarnation).toBe(c.incarnation);
  });

  it('SB07-F1-CAP-04: a fresh fake commandApproval run (parity sequence) satisfies the strict oracle and the fake sees a parity reply', async () => {
    const { client, report } = spawnFake({ turns: [{ commandApproval: { itemId: 'call_fake_1', command: 'echo sb07' }, text: 'done' }] });
    const { threadId, turnId } = await runOne(client);
    await client.close();
    const v = checkSb07RejectionPath(client.transcript, { threadId, incarnation: (client as { incarnation?: string }).incarnation });
    expect(v.violations).toEqual([]);
    expect(v.record).toMatchObject({ threadId, requestId: 0, turnId, itemId: 'call_fake_1' });
    expect(report().filter((r) => r.kind === 'violation')).toEqual([]);
    expect(report().find((r) => r.kind === 'server-request-answered')).toMatchObject({ id: 0, parity: true });
  });

  it('SB07-F1-CAP-05: the fake reports a non-parity reply to a commandApproval request as a violation', async () => {
    const { client, report } = spawnFake({ turns: [{ commandApproval: { itemId: 'call_fake_2' }, text: 'done' }] });
    client.onServerRequest = (r) => ({ error: { code: -32000, message: `${r.method} is not supported in exec mode for thread \`x\`` } });
    await runOne(client);
    await client.close();
    expect(report().filter((r) => r.kind === 'violation').map((r) => r.code)).toContain('non-parity-reply');
  });
});
