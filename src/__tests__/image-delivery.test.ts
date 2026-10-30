import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdapter } from '../db-adapter.js';
import { SessionStore } from '../session-store.js';
import { TurnContext } from '../turn-context.js';
import { createArtifactScope } from '../artifact-files.js';
import { deliverImages } from '../image-delivery.js';
import type { ImageArtifact } from '../artifacts.js';
import { uploadArtifact } from '../octo/media.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');
describe('native image pipeline against a local HTTP service', () => {
  let server: Server, apiUrl: string, root: string, store: SessionStore, turn: TurnContext;
  let requests: Array<{ path: string; bytes: Buffer; headers: Record<string, unknown> }>;
  let uploadFails: boolean, sendMode: 'ok' | 'fail' | 'lost' | 'empty', cancelAfterPut: boolean;
  let presignMode: 'ok' | 'fail' | 'unsafe' | 'small', losePut: boolean, revokeOnSend: boolean;
  let onPut: (() => void) | undefined;
  beforeEach(async () => {
    requests = []; uploadFails = false; sendMode = 'ok'; cancelAfterPut = false;
    presignMode = 'ok'; losePut = false; revokeOnSend = false;
    onPut = undefined;
    root = mkdtempSync(join(tmpdir(), 'native-images-'));
    store = new SessionStore(createAdapter(':memory:')); store.init(); turn = new TurnContext(30000);
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); const path = req.url!;
      requests.push({ path, bytes, headers: req.headers });
      if (path.startsWith('/v1/bot/upload/presigned')) {
        if (presignMode === 'fail') { res.statusCode = 403; res.end('TOKEN SECRET'); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ method: 'PUT', uploadUrl: presignMode === 'unsafe' ? 'http://169.254.169.254/credentials' : apiUrl + '/put?signature=SECRET', downloadUrl: apiUrl + '/image.png?signature=PRIVATE',
          contentType: 'image/png', contentDisposition: 'inline; filename="image.png"', maxFileSize: presignMode === 'small' ? 1 : 1024 }));
      } else if (path.startsWith('/put')) {
        onPut?.();
        if (cancelAfterPut) turn.cancel();
        if (losePut) { req.socket.destroy(); return; }
        res.statusCode = uploadFails ? 500 : 200; res.end(uploadFails ? 'SECRET raw image contents' : '');
      } else if (path === '/v1/bot/sendMessage') {
        if (revokeOnSend) turn.revoke();
        if (sendMode === 'lost') { req.socket.destroy(); return; }
        res.statusCode = sendMode === 'fail' ? 500 : 200;
        res.end(sendMode === 'ok' ? '{"message_id":12345}' : sendMode === 'empty' ? '{}' : 'SECRET PRIVATE');
      } else { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
    apiUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks();
  });
  function input(paths = ['one.png', 'two.png']) {
    const scope = createArtifactScope(root);
    paths.forEach((name, i) => { if (name !== 'missing.png') { const b = i ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==', 'base64') : Buffer.from(png); writeFileSync(join(scope.directory, name), b); } });
    return { apiUrl, botToken: 'TOKEN', channelId: 'group____topic', channelType: 5,
      scope, maxBytes: 1024, turn, store,
      artifacts: paths.map((path, i): ImageArtifact => ({ id: `a${i}`, kind: 'image', path, disposition: 'relay' })) };
  }
  it('uploads exact bytes with signed headers then sends native payloads in order', async () => {
    const params = input(); const results = await deliverImages(params);
    expect(results.map(r => r.delivery)).toEqual(['confirmed', 'confirmed']);
    expect(requests.map(r => r.path.split('?')[0])).toEqual(['/v1/bot/upload/presigned','/put','/v1/bot/sendMessage','/v1/bot/upload/presigned','/put','/v1/bot/sendMessage']);
    const put = requests[1]; expect(put.bytes).toEqual(png);
    expect(put.headers).toMatchObject({ 'content-length': String(png.length), 'content-type': 'image/png', 'content-disposition': 'inline; filename="image.png"' });
    expect(put.headers.authorization).toBeUndefined();
    expect(JSON.parse(requests[2].bytes.toString())).toMatchObject({ channel_id: 'group____topic', channel_type: 5,
      payload: { type: 2, width: 1, height: 1, size: png.length, name: 'one.png', url: apiUrl + '/image.png?signature=PRIVATE' } });
    expect(store.readImageDeliveries(turn.turnId)).toHaveLength(2);
    expect(JSON.stringify(store.readImageDeliveries(turn.turnId))).not.toMatch(/SECRET|PRIVATE|TOKEN/);
    await deliverImages(params); expect(requests).toHaveLength(6); // no second send on reentry
  });
  it('reports partial generation success without blocking later valid images', async () => {
    const results = await deliverImages(input(['missing.png', 'two.png']));
    expect(results[0]).toMatchObject({ generation: 'failed', upload: 'not_started', delivery: 'not_started' });
    expect(results[1].delivery).toBe('confirmed');
  });
  it('keeps upload failure separate and does not log server bodies', async () => {
    uploadFails = true; const log = vi.spyOn(console, 'error');
    const results = await deliverImages(input(['one.png']));
    expect(results[0]).toMatchObject({ generation: 'ready', upload: 'failed', delivery: 'not_started' });
    expect(requests).toHaveLength(2); expect(JSON.stringify(results)).not.toContain('SECRET'); expect(log).not.toHaveBeenCalled();
  });
  it.each(['fail', 'lost', 'empty'] as const)('preserves delivery unknown after %s and never resends', async mode => {
    sendMode = mode; const params = input(['one.png']);
    expect((await deliverImages(params))[0].delivery).toBe('unknown');
    expect(store.readImageDeliveries(turn.turnId)[0].messageId).toBeUndefined();
    expect((await deliverImages(params))[0].delivery).toBe('unknown');
    expect(requests.filter(r => r.path === '/v1/bot/sendMessage')).toHaveLength(1);
  });
  it('does not publish after cancellation during upload', async () => {
    cancelAfterPut = true;
    await expect(deliverImages(input(['one.png']))).rejects.toThrow();
    expect(requests.some(r => r.path === '/v1/bot/sendMessage')).toBe(false);
  });
  it('does no I/O after timeout or ownership revocation', async () => {
    const params = input(); turn.revoke();
    await expect(deliverImages(params)).rejects.toThrow(); expect(requests).toEqual([]);
  });
  it('keeps an attempted upload unknown when its response is lost', async () => {
    losePut = true; const params = input(['one.png']);
    expect((await deliverImages(params))[0]).toMatchObject({ upload: 'unknown', delivery: 'not_started' });
    await deliverImages(params); expect(requests).toHaveLength(2);
  });
  it.each(['fail', 'unsafe', 'small'] as const)('blocks invalid presign %s before PUT', async mode => {
    presignMode = mode;
    expect((await deliverImages(input(['one.png'])))[0]).toMatchObject({ upload: 'failed', delivery: 'not_started' });
    expect(requests).toHaveLength(1);
  });
  it('does not accept a late delivery ack after ownership revocation', async () => {
    revokeOnSend = true;
    await expect(deliverImages(input(['one.png']))).rejects.toThrow();
    expect(store.readImageDeliveries(turn.turnId)[0].delivery).toBe('unknown');
  });
  it('does not upload after the turn deadline', async () => {
    turn = new TurnContext(1); const params = input();
    await new Promise(resolve => setTimeout(resolve, 5));
    await expect(deliverImages(params)).rejects.toThrow(); expect(requests).toEqual([]);
  });
  it('deduplicates identical content and skips explicit external deliveries', async () => {
    const params = input(); writeFileSync(join(params.scope.directory, 'two.png'), png);
    params.artifacts[0].disposition = 'external';
    const results = await deliverImages(params);
    expect(results.map(r => r.delivery)).toEqual(['external', 'duplicate']); expect(requests).toEqual([]);
  });
  it('suppresses a relay copy when the external declaration comes later', async () => {
    const params = input(); writeFileSync(join(params.scope.directory, 'two.png'), png);
    params.artifacts[1].disposition = 'external';
    expect((await deliverImages(params)).map(r => r.delivery)).toEqual(['duplicate', 'external']);
    expect(requests).toEqual([]);
  });
  it.each(['jpeg', 'gif'])('ADV-95-001/002: rejects adversarial %s at generation with zero HTTP requests', format => {
    const params = input([format === 'jpeg' ? 'fake.jpg' : 'fake.gif']);
    const bytes = format === 'jpeg' ? Buffer.from('ffd8ffc00008080001000100ffdaffd9', 'hex')
      : Buffer.from('R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', 'base64');
    if (format === 'gif') { const pos = bytes.indexOf(0x2c); bytes.writeUInt16LE(65535, pos + 5); bytes.writeUInt16LE(65535, pos + 7); }
    writeFileSync(join(params.scope.directory, params.artifacts[0].path), bytes);
    return deliverImages(params).then(report => {
      expect(report[0]).toMatchObject({ generation: 'failed', upload: 'not_started', delivery: 'not_started' });
      expect(requests).toEqual([]);
    });
  });
  it('RVW-5: expiry of the presign budget does not cancel the independent PUT', async () => {
    const presignBudget = new AbortController(); const putBudget = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(presignBudget.signal).mockReturnValueOnce(putBudget.signal);
    onPut = () => presignBudget.abort();
    const url = await uploadArtifact({ apiUrl, botToken: 'TOKEN', name: 'x.png', mime: 'image/png', bytes: png,
      signal: turn.signal, check: () => turn.assertPublishable() });
    expect(url).toBe(apiUrl + '/image.png?signature=PRIVATE');
    expect(requests.map(r => r.path.split('?')[0])).toEqual(['/v1/bot/upload/presigned', '/put']);
  });
});
