import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EndpointPermissionHost, type EndpointHostPorts, type NativeHeader } from '../permissions/endpoint-host.js';
import { PermissionRefusal } from '../permissions/control-client.js';
import { ReplayJournal } from '../permissions/replay-journal.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { startBot, type BotStack } from '../index.js';
import { WKSocket } from '../octo/socket.js';
import { ChannelType, type BotMessage } from '../octo/types.js';
import { queryAgentEvents } from '../agent-bridge.js';
import { getUploadCredentials } from '../octo/api.js';

vi.mock('../octo/api.js', async original => ({ ...await original<typeof import('../octo/api.js')>(),
  registerBot: vi.fn(async () => ({ robot_id: 'bot', im_token: 'synthetic-im', ws_url: 'ws://127.0.0.1', owner_uid: 'human' })),
  getUploadCredentials: vi.fn(async () => ({})), sendHeartbeat: vi.fn(async () => {}),
}));
vi.mock('../octo/socket.js', () => ({ WKSocket: vi.fn(() => ({ connect: vi.fn(),
  disconnectAndWait: vi.fn(async () => {}), drainReceives: vi.fn(async () => {}) })) }));
vi.mock('../agent-bridge.js', async original => ({ ...await original<typeof import('../agent-bridge.js')>(), queryAgentEvents: vi.fn() }));

describe('startBot managed receive -> admission -> real MCP transports -> owned publication', () => {
  let root: string;
  let db: DbAdapter;
  let stack: BotStack | undefined;
  let host: EndpointPermissionHost;
  let ports: EndpointHostPorts;
  let server: Server | undefined;
  let url: string;
  let backend: number;
  let denyMcp: boolean;
  let requests: Array<{ params: { name: string }; method: string }>;
  const msg: BotMessage = { message_id: '41', message_seq: 7, from_uid: 'human', channel_id: 'human@bot',
    channel_type: ChannelType.DM, timestamp: 1, payload: { type: 1, content: 'SYNTHETIC_CURRENT_INPUT' } };
  const payloadSha256 = createHash('sha256').update(JSON.stringify(msg.payload)).digest('hex');
  const header: NativeHeader = { header_version: 1, header_reference: 'native_header', message_id: '41',
    source: { kind: 'dm', id: 'human@bot' }, parent_group: null, space_id: 'space', author_uid: 'human',
    author_kind: 'human', recipient_bot_uid: 'bot', native_message_version: 'native_version', payload_sha256: payloadSha256,
    delivery: { stream_id: 'synthetic-stream', stream_incarnation: 'a'.repeat(32), sequence: '7' } };

  beforeEach(async () => {
    vi.clearAllMocks(); root = mkdtempSync(join(tmpdir(), 'endpoint-host-'));
    db = createAdapter(join(root, 'journal.db'));
    backend = 0; denyMcp = false; requests = [];
    server = createServer(async (req, res) => {
      if (req.url === '/v1/bot/groups') { backend++; res.end('{"groups":[]}'); return; }
      let body = ''; for await (const chunk of req) body += String(chunk);
      const rpc = JSON.parse(body); requests.push(rpc);
      if (denyMcp) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32007, message: 'PERMISSION_REFUSED',
          data: { version: 1, category: 'capability_denied', correlation: '7'.repeat(32) } } })); return;
      }
      // Synthetic business receiver only. No claim about the actual CLI
      // evaluator/catalog/native adapters is made by this fixture.
      const downstream = await fetch(`${url}/v1/bot/groups`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: await downstream.text() }] } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    url = `http://127.0.0.1:${address.port}`;
    ports = {
      key: { origin: 'https://synthetic.invalid', bot_uid: 'bot', space_id: 'space' }, recipientId: 'synthetic:relay', relayTransport: 'stdio',
      catalog: { catalog_format: 'permission-release-manifest-v1', catalog_version: 'synthetic-frozen', catalog_digest: 'a'.repeat(64) },
      journal: new ReplayJournal(db, Buffer.alloc(32, 6), '1', { provision: true }),
      inspect: vi.fn(async () => ({ deliveryReference: 'native_receipt', header })), candidate: vi.fn(async () => true),
      control: { call: vi.fn(async (method, payload) => {
        if (method === 'register_ingress') return { ingress_id: '1'.repeat(32) };
        if (method === 'admit') return { capsule_id: '2'.repeat(32), turn_id: '3'.repeat(32), generation: '4'.repeat(32) };
        if (method === 'bind_context') return { context_generation: '4'.repeat(32) };
        if (method === 'open_relay') return { transport: payload.transport };
        return {};
      }) },
      prepareInput: vi.fn(async () => ({ input: 'SYNTHETIC_CURRENT_INPUT', originals: [header] })),
      runWorker: vi.fn(async () => 'SYNTHETIC_ANSWER'), publish: vi.fn(async () => {}),
      refuse: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    };
    host = new EndpointPermissionHost(ports);
    stack = await startBot({ botId: 'fixture', apiUrl: 'https://synthetic.invalid', botToken: 'SYNTHETIC_TOKEN',
      baseDir: root, cwd: join(root, 'work'), dataDir: join(root, 'data'), sdk: {},
      rateLimit: { maxPerMinute: 100 }, context: { maxContextChars: 6000, historyLimit: 40 },
      maxResponseChars: 5000, dispatchTimeoutMs: 10000, cards: { disable: false, eventTransport: 'off', reasoningSummary: 'off' },
    }, true, async () => host);
    await stack.connect();
  });
  afterEach(async () => {
    await stack?.shutdown(); stack = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  async function receive(message = structuredClone(msg)) {
    const options = vi.mocked(WKSocket).mock.calls[0][0];
    const reservation = await options.reserveBeforeAck!({ recipientUid: 'bot', message, payloadSha256 });
    if (reservation.disposition === 'reserved') {
      try { await options.onMessage(message); reservation.finish('terminal'); }
      catch { reservation.finish('uncertain'); }
    }
    return reservation.disposition;
  }

  async function rpcCall(transport: 'http' | 'stdio', rpc: unknown): Promise<Record<string, unknown>> {
    if (transport === 'http') return await (await fetch(`${url}/mcp`, {
      method: 'POST', body: JSON.stringify(rpc), signal: AbortSignal.timeout(3000),
    })).json() as Record<string, unknown>;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/permission-mcp-stdio.mjs', import.meta.url)), `${url}/mcp`],
      { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = ''; child.stdout.on('data', chunk => { out += String(chunk); }); child.stderr.on('data', chunk => { err += String(chunk); });
    child.on('error', error => { err += error.message; });
    const exited = once(child, 'close');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try {
      child.stdin.end(JSON.stringify(rpc) + '\n');
      const [code] = await exited; expect({ code, err }).toEqual({ code: 0, err: '' }); return JSON.parse(out);
    } finally {
      clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); await exited;
    }
  }

  it.each(['http', 'stdio'] as const)('carries both facade calls over %s after admission, with no legacy content/model path', async transport => {
    expect(getUploadCredentials).not.toHaveBeenCalled();
    ports.relayTransport = transport;
    ports.runWorker = vi.fn(async (binding, _input, relay) => {
      expect(relay.transport).toBe(transport);
      const replies: unknown[] = [];
      for (const name of ['execute', 'call_op']) {
        const rpc = { jsonrpc: '2.0', id: name, method: 'tools/call', params: { name,
          arguments: { operation_id: 'group.list', arguments: {} }, _meta: { octo: { version: 2,
            im: { sender: binding.header.author_uid, channel: binding.header.source.id, channel_type: 1,
              space_id: binding.header.space_id, message_id: binding.header.message_id } } } } };
        replies.push(await rpcCall(transport, rpc));
      }
      expect(replies).toHaveLength(2); return 'SYNTHETIC_ANSWER';
    });
    expect(await receive()).toBe('reserved');
    expect(requests.map(request => request.params.name)).toEqual(['execute', 'call_op']); expect(backend).toBe(2);
    expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'tools/call',
      params: expect.objectContaining({ _meta: { octo: { version: 2, im: { sender: 'human', channel: 'human@bot',
        channel_type: 1, space_id: 'space', message_id: '41' } } } }) })]));
    expect(ports.publish).toHaveBeenCalledOnce(); expect(ports.refuse).not.toHaveBeenCalled();
    expect(queryAgentEvents).not.toHaveBeenCalled(); // no inherited legacy SDK/context path
    expect(await receive()).toBe('duplicate'); expect(backend).toBe(2);
  });

  it('binds the complete 256-original union across control frames before starting a worker', async () => {
    const chunks: Buffer[] = [];
    const originalCall = ports.control.call;
    ports.control.call = vi.fn(async (method, payload) => {
      if (method !== 'bind_context') return originalCall(method, payload);
      const m = payload.manifest as { carrier: string; offset: number; bytes: number; data_base64: string };
      expect(m.carrier).toBe('canonical-json-chunks-v1');
      expect(m.offset).toBe(Buffer.concat(chunks).length);
      chunks.push(Buffer.from(m.data_base64, 'base64'));
      return Buffer.concat(chunks).length === m.bytes ? { context_generation: '4'.repeat(32) }
        : { accepted_bytes: Buffer.concat(chunks).length };
    });
    ports.prepareInput = vi.fn(async () => ({ input: 'SYNTHETIC_ALL_ORIGINALS', originals: Array.from({ length: 255 }, (_, i) => ({
      ...header, header_reference: `native_${i}`, message_id: String(100 + i),
    })) }));
    expect(await receive()).toBe('reserved');
    expect(chunks.length).toBeGreaterThan(1);
    expect(JSON.parse(Buffer.concat(chunks).toString()).originals).toHaveLength(256);
    expect(ports.runWorker).toHaveBeenCalledTimes(1); expect(ports.publish).toHaveBeenCalledTimes(1);
  });

  it('keeps the private catalog identity immutable across a caller mutation and fresh turn binding', async () => {
    Object.assign(ports.catalog!, { catalog_version: 'mutated-after-construction' });
    ports.runWorker = vi.fn(async binding => {
      expect(binding.catalog?.catalog_version).toBe('synthetic-frozen');
      expect(Object.isFrozen(binding.catalog)).toBe(true);
      return 'SYNTHETIC_RESULT';
    });
    expect(await receive()).toBe('reserved'); expect(ports.runWorker).toHaveBeenCalledTimes(1);
  });

  it('stops a running worker on authentic renewal denial and sends one fixed refusal without publishing a late result', async () => {
    vi.useFakeTimers();
    try {
      let started!: () => void; const running = new Promise<void>(resolve => { started = resolve; });
      const originalCall = ports.control.call;
      ports.control.call = vi.fn(async (method, payload) => {
        if (method === 'renew') throw new PermissionRefusal({ version: 1, category: 'invocation_denied', correlation: '9'.repeat(32) });
        return originalCall(method, payload);
      });
      ports.runWorker = vi.fn(async (_binding, _input, _relay, signal) => {
        started(); return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      });
      const handled = receive(); await running;
      await vi.advanceTimersByTimeAsync(30000); await handled;
      expect(ports.publish).not.toHaveBeenCalled(); expect(ports.refuse).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ports.refuse).mock.calls[0][2]).toBe(`This Agent cannot accept this request here. Reference: ${'9'.repeat(32)}`);
      expect(ports.control.call).toHaveBeenLastCalledWith('close', { capsule_id: '2'.repeat(32), reason: 'refused' });
    } finally { vi.useRealTimers(); }
  });

  it.each(['http', 'stdio'] as const)('handles an authenticated synthetic MCP refusal over %s without business dispatch/publication', async transport => {
    denyMcp = true;
    ports.relayTransport = transport;
    ports.runWorker = vi.fn(async (_binding, _input, relay) => {
      expect(relay.transport).toBe(transport);
      const response = await rpcCall(transport, { jsonrpc: '2.0', id: 'denied', method: 'tools/call',
        params: { name: 'execute', arguments: { operation_id: 'group.list', arguments: {} } } });
      const error = response.error as { code: number; data: { version: 1; category: 'capability_denied'; correlation: string } };
      expect(error.code).toBe(-32007);
      // The host-owned relay receives the authenticated coordinator result.
      // Model text is never interpreted as the out-of-band refusal channel.
      throw new PermissionRefusal(error.data);
    });
    await receive(); expect(requests).toHaveLength(1); expect(backend).toBe(0);
    expect(ports.publish).not.toHaveBeenCalled(); expect(ports.refuse).toHaveBeenCalledOnce();
    expect(ports.refuse).toHaveBeenCalledWith(expect.anything(),
      { version: 1, category: 'capability_denied', correlation: '7'.repeat(32) },
      `This attempt was blocked before dispatch. Reference: ${'7'.repeat(32)}`, expect.any(AbortSignal));
  });

  it('denies before input preparation, commands/model/MCP/publication and emits one handled refusal', async () => {
    const ordinary = ports.control.call;
    ports.control.call = vi.fn(async (method, payload) => {
      if (method === 'admit') throw new PermissionRefusal({ version: 1, category: 'invocation_denied', correlation: '5'.repeat(32) });
      return ordinary(method, payload);
    });
    await receive();
    expect(ports.prepareInput).not.toHaveBeenCalled(); expect(ports.runWorker).not.toHaveBeenCalled();
    expect(ports.publish).not.toHaveBeenCalled(); expect(queryAgentEvents).not.toHaveBeenCalled();
    expect(backend).toBe(0); expect(requests).toEqual([]); expect(ports.refuse).toHaveBeenCalledOnce();
    await receive(); expect(ports.refuse).toHaveBeenCalledOnce();
  });

  it('refuses unknown native authority before ACK/reservation/any control call', async () => {
    ports.inspect = vi.fn(async () => { throw new Error('SYNTHETIC_PRIVATE_DETAIL'); });
    expect(await receive()).toBe('unavailable');
    expect(ports.control.call).not.toHaveBeenCalled(); expect(ports.runWorker).not.toHaveBeenCalled();
    expect(db.prepare('SELECT count(*) AS n FROM permission_replay').get()).toEqual({ n: 0 });
  });

  it('rejects a changed generation before relay/model/native publication', async () => {
    const ordinary = ports.control.call;
    ports.control.call = vi.fn(async (method, payload) => method === 'bind_context'
      ? { context_generation: '6'.repeat(32) } : ordinary(method, payload));
    await receive(); expect(ports.runWorker).not.toHaveBeenCalled(); expect(ports.publish).not.toHaveBeenCalled();
    expect(ports.refuse).toHaveBeenCalledOnce(); expect(ports.control.call).toHaveBeenLastCalledWith('close',
      { capsule_id: '2'.repeat(32), reason: 'refused' });
  });

  it('retains ordinary worker failure as uncertain without inventing a permission refusal', async () => {
    ports.runWorker = vi.fn(async () => { throw new Error('SYNTHETIC_WORKER_FAILURE'); });
    await receive(); expect(ports.refuse).not.toHaveBeenCalled(); expect(ports.publish).not.toHaveBeenCalled();
    expect(db.prepare('SELECT state FROM permission_replay').get()).toEqual({ state: 'uncertain' });
  });

  it('accumulates complete contributor union and verifiedResume across same-generation turns, resetting on epoch or contributor change', async () => {
    let currentEpoch = '1';
    let currentGeneration = '4'.repeat(32);
    let currentTurnId = '3'.repeat(32);
    let allowAlice = true;
    const boundManifests: Array<{ context_id: string; context_generation: string; originals: NativeHeader[] }> = [];
    const admitPayloads: Array<Record<string, unknown>> = [];
    const resolveCalls: Array<Record<string, unknown>> = [];
    const seenResumes: Array<string | undefined> = [];
    const hdrHistory: NativeHeader = {
      ...header, header_reference: 'native_history_1', message_id: '499', author_uid: 'alice',
      delivery: { ...header.delivery, sequence: '99' },
    };

    ports.revalidateOriginal = vi.fn(async orig => {
      if (orig.headerReference === 'native_alice' && !allowAlice) return 'deny';
      return 'allow';
    });
    ports.control.call = vi.fn(async (method, payload) => {
      if (method === 'register_ingress') return { ingress_id: '1'.repeat(32) };
      if (method === 'admit') {
        admitPayloads.push(payload);
        return {
          capsule_id: '2'.repeat(32),
          turn_id: currentTurnId,
          generation: currentGeneration,
          scope_incarnation: 'b'.repeat(32),
          context_epoch: currentEpoch,
        };
      }
      if (method === 'resolve_contributors') {
        resolveCalls.push(payload);
        return { headers: [hdrHistory] };
      }
      if (method === 'bind_context') {
        boundManifests.push(payload.manifest as { context_id: string; context_generation: string; originals: NativeHeader[] });
        return { context_generation: currentGeneration };
      }
      if (method === 'open_relay') {
        expect(payload.include_tls_trust).toBe(true);
        return { transport: payload.transport };
      }
      return {};
    });

    const msg1: BotMessage = { ...msg, message_id: '501', message_seq: 101, from_uid: 'alice' };
    const hdr1: NativeHeader = {
      ...header, header_reference: 'native_alice', message_id: '501', author_uid: 'alice',
      delivery: { ...header.delivery, sequence: '101' },
    };
    const msg2: BotMessage = { ...msg, message_id: '502', message_seq: 102, from_uid: 'bob' };
    const hdr2: NativeHeader = {
      ...header, header_reference: 'native_bob', message_id: '502', author_uid: 'bob',
      delivery: { ...header.delivery, sequence: '102' },
    };
    const msg3: BotMessage = { ...msg, message_id: '503', message_seq: 103, from_uid: 'carol' };
    const hdr3: NativeHeader = {
      ...header, header_reference: 'native_carol', message_id: '503', author_uid: 'carol',
      delivery: { ...header.delivery, sequence: '103' },
    };
    const headersByMsgId = new Map<string, NativeHeader>([['501', hdr1], ['502', hdr2], ['503', hdr3]]);
    ports.inspect = vi.fn(async delivery => ({
      deliveryReference: `receipt_${delivery.message.message_id}`,
      header: headersByMsgId.get(delivery.message.message_id)!,
    }));
    ports.prepareInput = vi.fn(async binding => ({
      input: `INPUT_${binding.header.message_id}`,
      originals: [binding.header],
      ...(binding.header.message_id === '501' ? { contributorReferences: ['history_ref_499'] } : {}),
    }));
    ports.runWorker = vi.fn(async binding => {
      seenResumes.push(binding.verifiedResume?.sessionId);
      binding.bindSession?.('sess-gen-1', { workdir: join(root, 'work'), codexHome: join(root, 'data') });
      return `ANSWER_${binding.header.message_id}`;
    });

    // Turn 1 (Alice + resolved unseen history_ref_499): starts fresh generation, binds sess-gen-1
    expect(await receive(msg1)).toBe('reserved');
    expect(seenResumes).toEqual([undefined]);
    expect(admitPayloads[0]).not.toHaveProperty('prior_generation');
    expect(resolveCalls).toEqual([{ capsule_id: '2'.repeat(32), delivery_references: ['history_ref_499'] }]);
    expect(boundManifests[0].originals.map(h => h.header_reference).sort()).toEqual(['native_alice', 'native_history_1']);

    // Turn 2 (Bob, same epoch & incarnation): passes prior_generation, resumes sess-gen-1 with union [Alice, History1, Bob]
    currentTurnId = '5'.repeat(32);
    expect(await receive(msg2)).toBe('reserved');
    expect(admitPayloads[1]).toMatchObject({ proposed_context_id: boundManifests[0].context_id, prior_generation: '4'.repeat(32) });
    expect(seenResumes).toEqual([undefined, 'sess-gen-1']);
    expect(boundManifests[1].context_id).toBe(boundManifests[0].context_id);
    expect(boundManifests[1].originals.map(h => h.header_reference).sort()).toEqual(['native_alice', 'native_bob', 'native_history_1']);

    // Turn 3 (Carol, Alice now denied): resets generation before admit, clears prior contributors and session
    allowAlice = false;
    currentTurnId = '6'.repeat(32);
    currentGeneration = '7'.repeat(32);
    expect(await receive(msg3)).toBe('reserved');
    expect(admitPayloads[2]).not.toHaveProperty('prior_generation');
    expect(seenResumes).toEqual([undefined, 'sess-gen-1', undefined]);
    expect(boundManifests[2].context_id).not.toBe(boundManifests[0].context_id);
    expect(boundManifests[2].originals.map(h => h.header_reference)).toEqual(['native_carol']);
  });
});
