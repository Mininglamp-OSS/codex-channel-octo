#!/usr/bin/env node
/**
 * Mock OpenAI Responses provider for the real-binary job and the deployed test
 * stack (R8 §10.4: sdk.codexBaseUrl / openai_base_url points here). Serves both
 * transports codex 0.142.3 uses: the Responses websocket (`GET /v1/responses`
 * upgrade, `response.create` messages) and HTTP SSE (`POST /v1/responses`).
 * Every request is recorded; scripted steps control text, tool calls, delays
 * and hangs. Warm-up requests (`generate: false`) never consume a step.
 *
 *   node test/harness/mock-responses/server.mjs [--port 0] [--script steps.json]
 *
 * Step shapes: {text} | {functionCall:{name, arguments, callId?}} |
 *              {delayMs, text} | {hang:true} | {httpError: status}
 */
import http from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const redactAuth = (v) => (v ? `${v.split(' ')[0]} <sha256:${createHash('sha256').update(v).digest('hex').slice(0, 12)}>` : null);

/**
 * @param {{ script?: Array<Record<string, any>>, logPath?: string, port?: number }} [opts]
 */
export async function startMockResponses({ script = [], logPath, port = 0 } = {}) {
  const queue = [...script];
  let fallback = { text: 'mock-default' };
  const requests = [];
  const timers = new Set();
  const sockets = new Set();
  let responseCounter = 0;

  const record = (transport, req, body) => {
    const entry = { transport, at: performance.now(), headers: { ...req.headers }, body, warmup: body?.generate === false };
    requests.push(entry);
    if (logPath) {
      appendFileSync(logPath, JSON.stringify({ ...entry, headers: { ...entry.headers, authorization: redactAuth(entry.headers.authorization) } }) + '\n');
    }
    return entry;
  };
  const nextStep = (warmup) => (warmup ? { warmup: true } : (queue.shift() ?? fallback));
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

  /** Produce the event list for one response.create. */
  const events = (step) => {
    const id = `resp_${++responseCounter}`;
    const out = [{ type: 'response.created', response: { id } }];
    if (step.text !== undefined) {
      out.push({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${responseCounter}`, content: [{ type: 'output_text', text: step.text }] } });
    }
    if (step.functionCall) {
      const callId = step.functionCall.callId ?? `call_${responseCounter}`;
      out.push({ type: 'response.output_item.done', item: { type: 'function_call', id: `fc_${responseCounter}`, call_id: callId, name: step.functionCall.name, arguments: JSON.stringify(step.functionCall.arguments ?? {}) } });
    }
    out.push({ type: 'response.completed', response: { id, usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 15 } } });
    return out;
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      if (req.method === 'POST' && req.url?.endsWith('/responses')) {
        const entry = record('http', req, body);
        const step = nextStep(entry.warmup);
        if (step.httpError) { res.writeHead(step.httpError, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'scripted error' } })); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = () => {
          for (const ev of step.warmup ? events({}) : events(step)) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
          res.end();
        };
        if (step.hang) { res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_hang' } })}\n\n`); return; }
        if (step.delayMs) later(step.delayMs, send); else send();
        return;
      }
      record('http', req, body);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.endsWith('/responses')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (m) => {
        let body;
        try { body = JSON.parse(m.toString()); } catch { return; }
        const entry = record('ws', req, body);
        const step = nextStep(entry.warmup);
        const send = () => { if (ws.readyState === 1) for (const ev of step.warmup ? events({}) : events(step)) ws.send(JSON.stringify(ev)); };
        if (step.hang) { ws.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_hang' } })); return; }
        if (step.delayMs) later(step.delayMs, send); else send();
      });
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actualPort = server.address().port;

  const modelRequests = () => requests.filter((r) => !r.warmup && r.body && typeof r.body === 'object' && 'input' in r.body);
  return {
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}/v1`,
    requests,
    modelRequests,
    lastModelRequest: () => modelRequests().at(-1),
    push: (step) => queue.push(step),
    setDefault: (step) => { fallback = step; },
    async waitForModelRequests(n, timeoutMs = 30_000) {
      const start = performance.now();
      while (modelRequests().length < n) {
        if (performance.now() - start > timeoutMs) throw new Error(`mock responses: waited for ${n} model requests`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      for (const c of wss.clients) c.terminate();
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  const script = arg('--script') ? JSON.parse(readFileSync(arg('--script'), 'utf8')) : [];
  const mock = await startMockResponses({ script, port: Number(arg('--port') ?? 0), logPath: arg('--log') });
  console.log(JSON.stringify({ baseUrl: mock.baseUrl }));
  const stop = async () => { await mock.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
