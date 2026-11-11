/** Request-scoped HTTP(S) transport. Never re-resolve or share pooled sockets. */
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/** Internal connection boundary; addresses must come from resolvePublicUrl. */
export async function requestPinned(url: URL, addresses: ReadonlyArray<LookupAddress>, init: RequestInit = {}): Promise<Response> {
  if (!addresses.length) throw new Error('No approved addresses');
  const approved = addresses.map(a => ({ ...a }));
  const method = (init.method ?? 'GET').toUpperCase();
  let body: string | Uint8Array | undefined;
  if (init.body !== undefined && init.body !== null) {
    if (method === 'GET' || method === 'HEAD') throw new Error('GET/HEAD body is unsupported');
    if (typeof init.body === 'string') body = init.body;
    else if (init.body instanceof Uint8Array) body = init.body;
    else if (init.body instanceof ArrayBuffer) body = new Uint8Array(init.body);
    else if (init.body instanceof URLSearchParams) body = init.body.toString();
    else if (init.body instanceof Blob) body = new Uint8Array(await init.body.arrayBuffer());
    else throw new Error('Unsupported guarded request body');
  }
  init.signal?.throwIfAborted();
  const headers = new Headers(init.headers);
  // Keep the original authority and TLS identity, even with pinned DNS answers.
  headers.set('host', url.host);
  const lookup: LookupFunction = (_host, options, callback) => {
    const candidates = options.family ? approved.filter(a => a.family === options.family) : approved;
    if (!candidates.length) { callback(new Error('No approved address for family'), '', 0); return; }
    if ('all' in options && options.all) {
      // Node uses the all-address overload for bounded IPv6/IPv4 fallback.
      (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, candidates.map(a => ({ ...a })));
    } else callback(null, candidates[0].address, candidates[0].family);
  };
  return new Promise<Response>((resolve, reject) => {
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      method, headers: Object.fromEntries(headers), signal: init.signal ?? undefined,
      lookup, autoSelectFamily: true, agent: false,
      // HTTPS defaults retain CA and original-hostname verification. No custom
      // checkServerIdentity/rejectUnauthorized, proxy, or global Agent is used.
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, response => {
      const status = response.statusCode ?? 500;
      if (status < 200 || status > 599) { response.destroy(); reject(new Error('Invalid response status')); return; }
      if (init.redirect === 'error' && status >= 300 && status < 400) {
        response.destroy(); reject(new Error('Guarded request refused redirect')); return;
      }
      const responseHeaders = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
      if (method === 'HEAD' || [204, 205, 304].includes(status)) {
        response.resume(); resolve(new Response(null, { status, headers: responseHeaders })); return;
      }
      const encoding = responseHeaders.get('content-encoding')?.toLowerCase();
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
      const source = decoder ? response.pipe(decoder) : response;
      if (decoder) {
        responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length');
        response.on('error', error => decoder.destroy(error));
        decoder.on('close', () => response.destroy());
      }
      let settled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          source.on('data', (chunk: Buffer) => {
            if (settled) return;
            controller.enqueue(new Uint8Array(chunk));
            if ((controller.desiredSize ?? 0) <= 0) source.pause();
          });
          source.on('end', () => { if (!settled) { settled = true; controller.close(); } });
          source.on('error', error => {
            if (!settled) { settled = true; controller.error(init.signal?.aborted ? init.signal.reason : error); }
          });
        },
        pull() { source.resume(); },
        cancel() { settled = true; source.destroy(); response.destroy(); },
      });
      resolve(new Response(stream, { status, headers: responseHeaders }));
    });
    request.on('error', reject);
    request.end(body);
  });
}
