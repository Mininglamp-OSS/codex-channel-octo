import { expect, it, vi } from 'vitest';
// @ts-expect-error JavaScript smoke wrapper with injected supported transport.
import { smoke } from '../../scripts/capture_smoke.mjs';
const manifest = { apiUrl: 'https://example.com', expectedRobotId: 'bot-a', emptyTestBot: true,
  targets: [{ channelId: 'target', channelType: 2, expectedMemberUids: ['owner'] }] };
function transport(members = [{ uid: 'bot-a', role: 0 }, { uid: 'owner', role: 1 }]) {
  const disconnect = vi.fn();
  const construct = vi.fn();
  return { disconnect, construct, registerBot: vi.fn(async () => ({ robot_id: 'bot-a', im_token: 'fixture-im-token', ws_url: 'wss://example.com' })),
    getGroupMembers: vi.fn(async () => members), readback: vi.fn(async () => ({ complete: true, pages: 2, highWatermark: 3, messages: [] })),
    isAllowedApiUrl: () => true, isAllowedWsUrl: () => true,
    WKSocket: class { opts: { onConnected: () => void }; constructor(opts: { onConnected: () => void }) { construct(); this.opts = opts; }
      connect() { this.opts.onConnected(); } disconnect() { disconnect(); } } };
}
it('uses supported registration, CONNACK, membership and complete readback with cleanup', async () => {
  const records: unknown[] = []; const adapter = transport();
  await smoke(manifest, 'fixture-secret', (r: unknown) => records.push(r), adapter);
  expect(adapter.registerBot).toHaveBeenCalledOnce();
  expect(adapter.getGroupMembers).toHaveBeenCalledOnce();
  expect(adapter.readback).toHaveBeenCalledOnce();
  expect(adapter.disconnect).toHaveBeenCalledOnce();
  expect(JSON.stringify(records)).not.toMatch(/fixture-secret|fixture-im-token/);
});
it.each([
  ['false designation', { ...manifest, emptyTestBot: false }],
  ['missing designation', { ...manifest, emptyTestBot: undefined }],
  ['empty expected bot', { ...manifest, expectedRobotId: '' }],
  ['invalid target type', { ...manifest, targets: [{ channelId: 'target', channelType: 3 }] }],
  ['empty target', { ...manifest, targets: [{ channelId: '', channelType: 2 }] }],
  ['invalid member inventory', { ...manifest, targets: [{ channelId: 'target', channelType: 2, expectedMemberUids: 'owner' }] }],
  ['unverified DM', { ...manifest, targets: [{ channelId: 'dm', channelType: 1 }] }],
  ['invalid page size', { ...manifest, pageSize: 0 }],
  ['invalid lower watermark', { ...manifest, targets: [{ channelId: 'target', channelType: 2, lowWatermark: 0 }] }],
])('refuses %s before any network operation', async (_name, input) => {
  const adapter = transport();
  await expect(smoke(input, 'fixture-secret', () => {}, adapter)).rejects.toThrow();
  expect(adapter.registerBot).not.toHaveBeenCalled();
  expect(adapter.construct).not.toHaveBeenCalled();
  expect(adapter.getGroupMembers).not.toHaveBeenCalled();
  expect(adapter.readback).not.toHaveBeenCalled();
});
it('refuses a missing bot membership before reading the target transcript', async () => {
  const records: unknown[] = []; const adapter = transport([{ uid: 'owner', role: 1 }]);
  await expect(smoke(manifest, 'fixture-secret', (r: unknown) => records.push(r), adapter)).rejects.toThrow(/incomplete/);
  expect(adapter.readback).not.toHaveBeenCalled();
  expect(records).toContainEqual({ event: 'incomplete', reason: 'registration/connectivity/membership/readback verification failed' });
});
