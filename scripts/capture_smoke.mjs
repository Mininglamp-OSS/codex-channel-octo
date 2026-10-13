/** Sanctioned smoke/readback adapter using the package's existing supported Bot API and WKSocket. */
import { readFileSync, writeSync, fsyncSync } from 'node:fs';
import { sanitize } from './capture_proxy.mjs';

function validateManifest(manifest, token, isAllowedApiUrl) {
  const identity = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
  if (!manifest || typeof manifest !== 'object' || manifest.emptyTestBot !== true ||
      !identity(token) || !identity(manifest.expectedRobotId) || !identity(manifest.apiUrl) || !isAllowedApiUrl(manifest.apiUrl) ||
      !Array.isArray(manifest.targets) || !manifest.targets.length ||
      manifest.pageSize !== undefined && (!Number.isInteger(manifest.pageSize) || manifest.pageSize < 1 || manifest.pageSize > 1000)) {
    throw new Error('Invalid smoke manifest or empty test-bot attestation');
  }
  const api = new URL(manifest.apiUrl);
  if (api.username || api.password || api.search || api.hash) throw new Error('Invalid smoke API target');
  const targets = new Set();
  for (const target of manifest.targets) {
    if (!target || typeof target !== 'object' || !identity(target.channelId) || ![1, 2].includes(target.channelType) ||
        target.lowWatermark !== undefined && (!Number.isSafeInteger(target.lowWatermark) || target.lowWatermark < 1) ||
        target.expectedMemberUids !== undefined && (!Array.isArray(target.expectedMemberUids) || !target.expectedMemberUids.every(identity)) ||
        target.channelType === 1 && (!identity(manifest.expectedDmChannelId) || target.channelId !== manifest.expectedDmChannelId)) {
      throw new Error('Invalid smoke target inventory');
    }
    const key = JSON.stringify([target.channelType, target.channelId]);
    if (targets.has(key)) throw new Error('Duplicate smoke target');
    targets.add(key);
  }
}

export async function smoke(manifest, token, record, adapter) {
  const { registerBot, getGroupMembers, WKSocket, isAllowedApiUrl, isAllowedWsUrl, readback } = adapter ??
    Object.assign({}, ...await Promise.all(['api', 'socket', 'evidence'].map(name => import(`../dist/octo/${name}.js`))),
      await import('../dist/url-policy.js'));
  // Validate every locally checkable designation/target field before registration or WS construction.
  validateManifest(manifest, token, isAllowedApiUrl);
  const secretValues = [token];
  const emit = value => record(sanitize(value, secretValues));
  try {
    const registered = await registerBot({ apiUrl: manifest.apiUrl, botToken: token, signal: AbortSignal.timeout(5000) });
    secretValues.push(registered.im_token);
    if (registered.robot_id !== manifest.expectedRobotId || !isAllowedWsUrl(registered.ws_url)) throw new Error('Unexpected bot/WS target');
    emit({ event: 'registration', robotId: registered.robot_id, ownerUid: registered.owner_uid, ownerChannelId: registered.owner_channel_id });
    let socket;
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Connectivity deadline')), 5000);
        socket = new WKSocket({ wsUrl: registered.ws_url, uid: registered.robot_id, token: registered.im_token,
          onMessage: () => reject(new Error('Unexpected traffic on empty smoke bot')),
          onConnected: resolve, onError: () => reject(new Error('WS smoke failure')) });
        socket.connect();
      });
      emit({ event: 'connectivity', connack: true });
    } finally { clearTimeout(timer); socket?.disconnect(); }
    for (const target of manifest.targets) {
      if (target.channelType === 2) {
        const members = await getGroupMembers({ apiUrl: manifest.apiUrl, botToken: token,
          groupNo: target.channelId, signal: AbortSignal.timeout(5000) });
        if (!members.some(m => m.uid === registered.robot_id)) throw new Error('Bot absent from intended target');
        for (const uid of target.expectedMemberUids ?? []) if (!members.some(m => m.uid === uid)) throw new Error('Expected test member absent');
        emit({ event: 'membership', target, members: members.map(m => ({ uid: m.uid, role: m.role })) });
      } else if (target.channelType !== 1 || target.channelId !== manifest.expectedDmChannelId) throw new Error('Unverified DM target');
      const evidence = await readback({ apiUrl: manifest.apiUrl, botToken: token, channelId: target.channelId,
        channelType: target.channelType, lowWatermark: target.lowWatermark, pageSize: manifest.pageSize,
        signal: AbortSignal.timeout(15000) });
      emit({ event: 'readback', target, ...evidence });
    }
  } catch {
    emit({ event: 'incomplete', reason: 'registration/connectivity/membership/readback verification failed' });
    throw new Error('Smoke incomplete');
  }
}

if (process.env.ENV02_MANIFEST_FD && process.argv[1]?.endsWith('/capture_smoke.mjs')) {
  const manifest = JSON.parse(readFileSync(Number(process.env.ENV02_MANIFEST_FD), 'utf8'));
  const token = readFileSync(Number(process.env.ENV02_TOKEN_FD), 'utf8').trim();
  const fd = Number(process.env.ENV02_EVIDENCE_FD);
  try { await smoke(manifest, token, value => { writeSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); }); }
  catch { process.exitCode = 1; }
}
