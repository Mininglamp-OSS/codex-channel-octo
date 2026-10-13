/**
 * Scripted fake Octo REST server (R8 §10.1 layer 2). Records every request
 * (method, raw path, raw query, Authorization, body), serves scripted routes and
 * applies api.forceStatus(endpoint) faults from a FaultPlan.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FaultPlan } from '../../../src/seams/fault-plan.js';
import { NO_FAULTS } from '../../../src/seams/fault-plan.js';

export interface RestRequest {
  method: string;
  /** Raw (still percent-encoded) path without the query string. */
  path: string;
  rawPath: string;
  query: string;
  authorization: string | null;
  body: unknown;
  at: number;
}
export type RouteResult = { status: number; body?: unknown; rawBody?: string; headers?: Record<string, string> };
export type RouteHandler = (req: RestRequest) => RouteResult | Promise<RouteResult>;

/** Endpoint names used by api.forceStatus(endpoint, …). */
export function endpointName(path: string): string {
  const p = path.replace(/^\/v1\/bot\//, '');
  if (p === 'register') return 'register';
  if (/^groups\/[^/]+\/members$/.test(p)) return 'group/members';
  if (/^groups\/[^/]+\/mention_pref$/.test(p)) return 'mention_pref';
  if (/^groups\/[^/]+\/threads\/[^/]+\/md$/.test(p)) return 'thread/md';
  if (/^groups\/[^/]+\/md$/.test(p)) return 'group/md';
  return p;
}

export class FakeOctoRest {
  readonly requests: RestRequest[] = [];
  private readonly routes = new Map<string, RouteHandler>();
  private messageCounter = 1000;

  private constructor(private readonly server: Server, private readonly opts: { faults?: FaultPlan; register?: Record<string, string> }) {
    server.on('request', (req, res) => { void this.handle(req, res); });
    const reg = () => ({ status: 200, body: { robot_id: 'u_fake_bot', im_token: 'fake_im', ws_url: 'ws://127.0.0.1:1', api_url: this.url, owner_uid: '', owner_channel_id: '', ...opts.register } });
    this.setRoute('POST', '/v1/bot/register', reg);
    for (const p of ['heartbeat', 'typing', 'readReceipt']) this.setRoute('POST', `/v1/bot/${p}`, () => ({ status: 200, body: {} }));
    this.setRoute('POST', '/v1/bot/sendMessage', (r) => ({
      status: 200, body: { message_id: String(++this.messageCounter), client_msg_no: (r.body as { client_msg_no?: string })?.client_msg_no ?? '', message_seq: this.messageCounter },
    }));
  }

  static async start(opts: { faults?: FaultPlan; register?: Record<string, string> } = {}): Promise<FakeOctoRest> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return new FakeOctoRest(server, opts);
  }

  get url(): string { return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`; }

  setRoute(method: string, path: string, handler: RouteHandler): void {
    this.routes.set(`${method} ${path}`, handler);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : undefined; } catch { /* keep raw text */ }
    const url = req.url ?? '/';
    const q = url.indexOf('?');
    const path = q >= 0 ? url.slice(0, q) : url;
    const record: RestRequest = {
      method: req.method ?? 'GET', path, rawPath: path, query: q >= 0 ? url.slice(q + 1) : '',
      authorization: (req.headers.authorization as string | undefined) ?? null, body, at: performance.now(),
    };
    this.requests.push(record);
    const decision = (this.opts.faults ?? NO_FAULTS).decide({ name: 'api.forceStatus', endpoint: endpointName(path) });
    let result: RouteResult;
    if (decision.kind === 'status') {
      result = { status: decision.status, body: { error: 'forced by fault plan' } };
    } else {
      const handler = this.routes.get(`${record.method} ${path}`);
      result = handler ? await handler(record) : { status: 404, body: { error: 'not found' } };
    }
    res.writeHead(result.status, { 'content-type': 'application/json', ...result.headers });
    res.end(result.rawBody ?? (result.body === undefined ? '' : JSON.stringify(result.body)));
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
