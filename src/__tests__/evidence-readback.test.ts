import { afterEach, expect, it, vi } from 'vitest';
import { readback } from '../octo/evidence.js';
import { writeFileSync } from 'node:fs';
const options = { apiUrl: 'https://example.com', botToken: 'fixture-token', channelId: 'target', channelType: 2 };
afterEach(() => vi.unstubAllGlobals());
function mock(pages: unknown[]) {
  const bodies: Record<string, number>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(pages.shift()), { status: 200 });
  }));
  return bodies;
}
const row = (n: number) => ({ message_seq: n, message_id: String(9000000000000000n + BigInt(n)), from_uid: 'sender', timestamp: n, payload: { content: 'fixture' } });
it('traverses every page under the original high watermark and preserves int64 IDs', async () => {
  const bodies = mock([{ messages: [row(5)] }, { messages: [row(5), row(4)] },
    { messages: [row(3), row(2)] }, { messages: [row(1)] }]);
  const result = await readback({ ...options, pageSize: 2 });
  expect(result.messages.map(m => m.message_seq)).toEqual([1, 2, 3, 4, 5]);
  expect(result.highWatermark).toBe(5);
  expect(result.pages).toBe(3);
  expect(bodies.slice(1).map(b => b.start_message_seq)).toEqual([6, 4, 2]);
  if (process.env.ENV02_EVIDENCE_DIR) writeFileSync(`${process.env.ENV02_EVIDENCE_DIR}/readback-fixture.json`, JSON.stringify(result, null, 2));
});
it('decodes payloads and sanitizes credentials without destroying body hashes', async () => {
  mock([{ messages: [row(1)] }, { messages: [{ ...row(1), payload: Buffer.from(JSON.stringify({ content: 'Bearer fixture-token', token: 'other' })).toString('base64') }] }]);
  const evidence = await readback(options);
  expect(JSON.stringify(evidence)).not.toContain('fixture-token');
  expect(JSON.stringify(evidence)).not.toContain('other');
  expect(evidence.messages[0].payloadHash).toMatch(/^[a-f0-9]{64}$/);
});
it('refuses sequence gaps even when both bounds are present', async () => {
  mock([{ messages: [row(3)] }, { messages: [row(3), row(1)] }]);
  await expect(readback(options)).rejects.toThrow(/gap/i);
});
it('fails visibly if a server silently caps history before the lower bound', async () => {
  mock([{ messages: [row(5)] }, { messages: [row(5), row(4)] }, { messages: [] }]);
  await expect(readback({ ...options, pageSize: 2 })).rejects.toThrow(/incomplete/i);
});
it('rejects duplicate or non-progressing pages', async () => {
  mock([{ messages: [row(4)] }, { messages: [row(4), row(3)] }, { messages: [row(4), row(3)] }]);
  await expect(readback({ ...options, pageSize: 2 })).rejects.toThrow(/cursor|page/i);
});
it('rejects a moving high watermark rather than mixing snapshots', async () => {
  mock([{ messages: [row(4)] }, { messages: [row(5)] }]);
  await expect(readback(options)).rejects.toThrow(/watermark|cursor/i);
});
it('never converts HTTP failure into empty successful evidence', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Bearer fixture-token', { status: 503 })));
  await expect(readback(options)).rejects.toThrow(/incomplete/i);
});

it.each(['not-an-id', '9223372036854775808', '-1', '0', ' ', '01', '', -1, 0, 1.5, null])('rejects malformed identity %s in the readback page', async id => {
  mock([{ messages: [row(1)] }, { messages: [{ ...row(1), message_id: id }] }]);
  await expect(readback(options)).rejects.toThrow('invalid message identity');
});
it('validates identities in the high-watermark probe before pagination', async () => {
  const calls = mock([{ messages: [{ ...row(1), message_id: 'not-an-id' }] }, { messages: [row(1)] }]);
  await expect(readback(options)).rejects.toThrow('invalid message identity');
  expect(calls).toHaveLength(1);
});
it.each([123, '123', '9223372036854775807'])('accepts and normalizes canonical ID %s', async id => {
  const entry = { ...row(1), message_id: id };
  mock([{ messages: [entry] }, { messages: [entry] }]);
  expect((await readback(options)).messages[0].messageId).toBe(String(id));
});
it('preserves a raw numeric int64 response without rounding it', async () => {
  const text = '{"messages":[{"message_seq":1,"message_id":9223372036854775807,"from_uid":"sender","timestamp":1,"payload":{}}]}';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(text)));
  expect((await readback(options)).messages[0].messageId).toBe('9223372036854775807');
});

it('accepts a 16-digit numeric wire ID via the lossless REST parser', async () => {
  const entry = { ...row(1), message_id: 9007199254740992 };
  mock([{ messages: [entry] }, { messages: [entry] }]);
  expect((await readback(options)).messages[0].messageId).toBe('9007199254740992');
});
