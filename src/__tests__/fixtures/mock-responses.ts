/**
 * Local stand-in for the Responses API (SSE), for real-binary app-server
 * harness tests. Synthetic only: it accepts any bearer key and records each
 * request. The latest user text selects the reply:
 * - contains `SHELL:<cmd>` → one `exec_command` call, then a final message;
 * - contains `SLOW:<ms>` → the final message after a delay;
 * - contains `TOOL:<name>:<json args>` → one call of that function tool, then
 *   a final message quoting the tool output;
 * - otherwise → the final message `hello from mock`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

export interface MockResponses {
  readonly baseUrl: string;
  readonly requests: MockRequest[];
  close(): Promise<void>;
}

function userTexts(body: Record<string, unknown>): string[] {
  const input = Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : [];
  return input.filter((i) => i.role === 'user').flatMap((i) => (Array.isArray(i.content) ? i.content as Array<Record<string, unknown>> : []))
    .map((c) => (typeof c.text === 'string' ? c.text : ''));
}

export async function startMockResponses(): Promise<MockResponses> {
  const requests: MockRequest[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => { raw += d.toString('utf8'); });
    req.on('end', () => {
      // Websocket upgrade attempts: refuse so the client falls back to HTTP SSE.
      if (req.method !== 'POST') { res.writeHead(404).end(); return; }
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep empty */ }
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      const id = `resp_${++n}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (o: Record<string, unknown>): void => { res.write(`event: ${String(o.type)}\ndata: ${JSON.stringify(o)}\n\n`); };
      const done = (): void => {
        ev({ type: 'response.completed', response: { id, usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 8 } } });
        res.end();
      };
      const message = (text: string): void => {
        ev({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text }] } });
      };
      ev({ type: 'response.created', response: { id } });
      const input = Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : [];
      const last = userTexts(body).at(-1) ?? '';
      const answered = input.some((i) => i.type === 'function_call_output');
      const shell = /SHELL:(.+)$/m.exec(last);
      const slow = /SLOW:(\d+)/.exec(last);
      const tool = /TOOL:([a-z_]+):(\{.*\})$/m.exec(last);
      if (tool && !answered) {
        ev({ type: 'response.output_item.done', item: { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: tool[1], arguments: tool[2] } });
        done();
      } else if (tool) {
        const out = input.find((i) => i.type === 'function_call_output') as { output?: unknown } | undefined;
        message(`tool said ${typeof out?.output === 'string' ? out.output : JSON.stringify(out?.output)}`);
        done();
      } else if (shell && !answered) {
        ev({ type: 'response.output_item.done', item: { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'exec_command', arguments: JSON.stringify({ cmd: shell[1], yield_time_ms: 250_000 }) } });
        done();
      } else if (slow) {
        setTimeout(() => { message('hello from mock'); done(); }, Number(slow[1]));
      } else {
        message('hello from mock');
        done();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
