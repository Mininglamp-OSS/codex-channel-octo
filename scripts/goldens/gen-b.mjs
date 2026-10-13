#!/usr/bin/env node
/**
 * Generate B goldens by executing pinned openclaw-channel-octo source (R8 §10.3).
 *
 *   node scripts/goldens/gen-b.mjs [--b <path to B checkout>] [--check]
 *
 * - Verifies the B checkout HEAD equals test/pins.json "B" and records the
 *   sha256 of every source file it executes or parses.
 * - Bundles B src/socket.ts unmodified with esbuild, appending only an export
 *   statement for module-private functions, then runs it with fixed inputs.
 * - Extracts with the TypeScript AST (R8 amendment A-R8-PM05-01): the
 *   octo_management action enum (src/agent-tools.ts), the advertised
 *   message-tool action list (src/channel.ts getAvailableActions), every
 *   reachable handleOctoMessageAction route (src/actions.ts), and the
 *   factory/registration/dispatcher ownership (file, symbol, lines, sha256).
 * - Writes test/goldens/b/*.json plus a `<file>.sha256` beside each output.
 *   --check regenerates into memory and fails if committed outputs differ.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(ROOT, 'package.json'));
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const B = resolve(argVal('--b', join(ROOT, '..', 'openclaw-channel-octo')));
const CHECK = args.includes('--check');
const OUT = join(ROOT, 'test', 'goldens', 'b');
const pins = JSON.parse(readFileSync(join(ROOT, 'test', 'pins.json'), 'utf8'));

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const hex = (b) => Buffer.from(b).toString('hex');
const fail = (m) => { console.error(`gen-b: ${m}`); process.exit(1); };

const head = execFileSync('git', ['-C', B, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== pins.B) fail(`B checkout HEAD ${head} != pinned ${pins.B}`);
const dirty = execFileSync('git', ['-C', B, 'status', '--porcelain', '--', 'src/socket.ts', 'src/agent-tools.ts', 'src/channel.ts', 'src/actions.ts', 'index.ts'], { encoding: 'utf8' }).trim();
if (dirty) fail(`B source files are modified:\n${dirty}`);

const sources = {};
const readSource = (rel) => { const buf = readFileSync(join(B, rel)); sources[rel] = sha256(buf); return buf.toString('utf8'); };

// ── execute B socket.ts ────────────────────────────────────────────────────
readSource('src/socket.ts');
const SHIM = '\nexport { Encoder, Decoder, encodeConnectPacket, encodeRecvackPacket, aesDecrypt, aesEncrypt, parseSettingByte, encodeVariableLength, stringToUint, uintToString, generateDeviceID, PROTO_VERSION };\n';
const cacheDir = join(ROOT, '.cache', 'goldens');
mkdirSync(cacheDir, { recursive: true });
const bundlePath = join(cacheDir, 'b-socket.bundle.mjs');
await esbuild.build({
  entryPoints: [join(B, 'src', 'socket.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: bundlePath, logLevel: 'error',
  external: ['ws', 'curve25519-js', 'crypto-js', 'md5-typescript', 'buffer', 'events'],
  plugins: [{
    name: 'append-export-shim',
    setup(build) {
      build.onLoad({ filter: /src[\\/]socket\.ts$/ }, (a) => ({ contents: readFileSync(a.path, 'utf8') + SHIM, loader: 'ts' }));
    },
  }],
});
console.debug = () => undefined; // B logs expected decrypt failures for the poison vectors
const Bmod = await import(pathToFileURL(bundlePath).href + `?t=${Date.now()}`);
const { generateKeyPair } = require('curve25519-js');
const depVersions = Object.fromEntries(['crypto-js', 'curve25519-js', 'md5-typescript', 'ws'].map((d) => [d, require(`${d}/package.json`).version]));

const seed = (label) => createHash('sha256').update(label).digest();

// encoder vectors
const encoderVectors = [
  [['writeByte', 0x7f]], [['writeInt16', 0xbeef]], [['writeInt32', 0x1234abcd]], [['writeInt32', 0xdeadbeef]],
  [['writeInt64', '9007199254740993123']], [['writeInt64', '0']], [['writeString', 'hello']], [['writeString', '你好 😀']],
  [['writeString', '']], [['writeString', 'x'.repeat(300)]],
  [['writeByte', 4], ['writeString', 'dev'], ['writeInt64', '1791900000000'], ['writeString', 'k']],
].map((ops) => {
  const e = new Bmod.Encoder();
  for (const [op, a] of ops) { if (op === 'writeInt64') e.writeInt64(BigInt(a)); else e[op](a); }
  return { ops, bytesHex: hex(e.toUint8Array()) };
});

// truncated decode: B Decoder silently returns garbage where A must throw
const truncatedDecode = [['readInt16', [0x01]], ['readInt32', [0x01, 0x02, 0x03]], ['readString', [0x00, 0x05, 0x41]]].map(([op, bytes]) => {
  const d = new Bmod.Decoder(Uint8Array.from(bytes));
  const v = d[op]();
  return { op, bytesHex: hex(Uint8Array.from(bytes)), bResult: typeof v === 'number' && Number.isNaN(v) ? 'NaN' : v };
});

// CONNECT vectors (Math.random fixed so B's own generateDeviceID is deterministic)
const connect = [];
for (const [i, token] of [['1', 'im_token_golden'], ['2', 'T'.repeat(300)]]) {
  const realRandom = Math.random;
  Math.random = () => 0.5;
  const deviceID = Bmod.generateDeviceID() + 'W';
  Math.random = realRandom;
  const clientSeed = seed(`dev01-golden-client-${i}`);
  const clientKey = Buffer.from(generateKeyPair(clientSeed).public).toString('base64');
  const v = { uid: 'u_bot_golden', token, clientTimestamp: 1791900000000, mathRandom: 0.5, clientSeedHex: hex(clientSeed), deviceID, clientKey };
  const frame = Bmod.encodeConnectPacket({ version: Bmod.PROTO_VERSION, deviceFlag: 0, deviceID, uid: v.uid, token, clientTimestamp: v.clientTimestamp, clientKey });
  connect.push({ ...v, frameHex: hex(frame) });
}

// Inline server-side encoder (independent of the test harness codec)
const varint = (n) => { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 0x80; o.push(d); } while (n > 0); return o; };
const str = (s) => { const b = Buffer.from(s, 'utf8'); return [(b.length >> 8) & 0xff, b.length & 0xff, ...b]; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return [...b]; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return [...b]; };
const frameOf = (type, flags, body) => Uint8Array.from([(type << 4) | flags, ...varint(body.length), ...body]);
const connackFrame = (serverVersion, serverKey, salt) =>
  frameOf(2, 1, [serverVersion, ...i64(0), 1, ...str(serverKey), ...str(salt), ...(serverVersion >= 4 ? i64(0) : [])]);
const recvFrame = (s, serverVersion, payload) => frameOf(5, 0, [
  s.setting, ...str(s.msgKey), ...str(s.fromUid), ...str(s.channelId), s.channelType,
  ...(serverVersion >= 3 ? i32(s.expire) : []), ...str(s.clientMsgNo), ...i64(s.messageId), ...i32(s.messageSeq), ...i32(s.timestamp),
  ...(((s.setting >> 3) & 1) ? str(s.topic) : []), ...payload,
]);

/** Drive B's real WKSocket packet path with a stub transport. */
function bSession(clientSeed) {
  const sent = [];
  const got = [];
  const sock = new Bmod.WKSocket({ wsUrl: 'ws://stub', uid: 'u', token: 't', onMessage: (m) => got.push(m) });
  sock.ws = { readyState: 1, send: (d) => sent.push(Uint8Array.from(d)), close() {}, removeAllListeners() {} };
  sock.dhPrivateKey = generateKeyPair(clientSeed).private;
  const settle = () => { sock.stopHeart(); sock.clearStableTimer(); sock.clearConnectDeadline(); };
  return { sock, sent, got, settle };
}

const aes = [];
const session = [];
for (const serverVersion of [4, 3]) {
  const clientSeed = seed(`dev01-golden-session-client-v${serverVersion}`);
  const serverSeed = seed(`dev01-golden-session-server-v${serverVersion}`);
  const salt = `golden-salt-v${serverVersion}-0123456789`;
  const serverKey = Buffer.from(generateKeyPair(serverSeed).public).toString('base64');
  const s = bSession(clientSeed);
  const connack = connackFrame(serverVersion, serverKey, salt);
  s.sock.handleRawData(connack);
  s.settle();
  const { aesKey, aesIV } = s.sock;
  if (!s.sock.connected || aesKey.length !== 16) fail('B did not accept the generated CONNACK');
  // AES vector via B aesEncrypt/aesDecrypt with the B-derived session key
  const plaintext = JSON.stringify({ type: 1, content: `aes vector v${serverVersion} 你好 😀` });
  const ct = Bmod.aesEncrypt(plaintext, aesKey, aesIV);
  const bDecrypted = Bmod.uintToString(Array.from(Bmod.aesDecrypt(Uint8Array.from(Buffer.from(ct, 'latin1')), aesKey, aesIV)));
  const { sharedKey } = require('curve25519-js');
  aes.push({
    clientSeedHex: hex(clientSeed), serverSeedHex: hex(serverSeed),
    sharedSecretBase64: Buffer.from(sharedKey(generateKeyPair(clientSeed).private, generateKeyPair(serverSeed).public)).toString('base64'),
    aesKey, salt, aesIV, plaintext, ciphertextBase64: ct, bDecrypted,
  });
  const specs = [
    { setting: 0, msgKey: 'k1', fromUid: 'u_alice', channelId: 'u_alice', channelType: 1, expire: 0, clientMsgNo: 'c1', messageId: '9007199254740993123', messageSeq: 42, timestamp: 1791900000, payloadObj: { type: 1, content: 'hello golden' } },
    { setting: 0x0a, msgKey: 'k2', fromUid: 'u_bob', channelId: 'g_golden', channelType: 2, expire: 7, clientMsgNo: 'c2', messageId: '18446744073709551615', messageSeq: 4294967295, timestamp: 1, topic: 'tp', payloadObj: { type: 1, content: 'topic + stream', mention: { uids: ['u_bot'] } } },
    { setting: 0x80, msgKey: '', fromUid: 'u_carol', channelId: 'g_golden____t1', channelType: 5, expire: 0, clientMsgNo: '', messageId: '1', messageSeq: 1, timestamp: 2, payloadObj: { type: 14, content: [{ type: 'text', text: '富文本 😀' }], plain: '富文本 😀' } },
    { setting: 0, msgKey: 'k4', fromUid: 'u_mallory', channelId: 'u_mallory', channelType: 1, expire: 0, clientMsgNo: 'c4', messageId: '777', messageSeq: 7, timestamp: 3, poison: true },
  ];
  const recv = [];
  for (const spec of specs) {
    const payloadBase64Ascii = spec.poison ? 'not-a-valid-ciphertext!!' : Bmod.aesEncrypt(JSON.stringify(spec.payloadObj), aesKey, aesIV);
    const frame = recvFrame(spec, serverVersion, [...Buffer.from(payloadBase64Ascii, 'latin1')]);
    const sentBefore = s.sent.length;
    const gotBefore = s.got.length;
    s.sock.handleRawData(frame);
    const msg = s.got.length > gotBefore ? s.got.at(-1) : null;
    const ack = s.sent.length > sentBefore ? s.sent.at(-1) : null;
    if (msg && (msg.message_id !== spec.messageId || msg.message_seq !== spec.messageSeq || msg.from_uid !== spec.fromUid || msg.channel_id !== spec.channelId)) {
      fail(`B decoded RECV differently from the generator spec: ${JSON.stringify(msg)}`);
    }
    if (!spec.poison && !msg) fail('B did not decode a valid RECV vector');
    const { payloadObj: _p, poison: _q, ...rest } = spec;
    recv.push({ spec: { ...rest, topic: rest.topic ?? undefined, payloadBase64Ascii }, frameHex: hex(frame), bOnMessage: msg ? JSON.parse(JSON.stringify(msg)) : null, bRecvackHex: ack ? hex(ack) : null });
  }
  session.push({ name: `server-v${serverVersion}`, clientSeedHex: hex(clientSeed), serverVersion, connackFrameHex: hex(connack), serverKey, salt, recv });
}

const wire = {
  generator: 'scripts/goldens/gen-b.mjs',
  source: { repo: 'Mininglamp-OSS/openclaw-channel-octo', commit: pins.B, files: { 'src/socket.ts': sources['src/socket.ts'] } },
  dependencies: depVersions,
  method: 'B src/socket.ts bundled unmodified by esbuild with an appended export statement; executed with fixed seeds, Math.random=0.5 and a stub transport',
  vectors: { encoder: encoderVectors, truncatedDecode, connect, aes, session },
};

// ── action inventories via TypeScript AST (A-R8-PM05-01) ─────────────────
const AMENDMENT = { id: 'A-R8-PM05-01', ratification: 'b57277b2-618e-4da2-8291-3dba7b0b1c5f', doc: 'docs/amendments/R8-AMD-01.md' };
const parsed = {};
function parse(rel) { return (parsed[rel] ??= ts.createSourceFile(rel, readSource(rel), ts.ScriptTarget.Latest, true)); }
function stringArray(node) {
  return ts.isArrayLiteralExpression(node) && node.elements.every(ts.isStringLiteral) ? node.elements.map((e) => e.text) : null;
}
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
/** Ownership provenance for an AST node: file, symbol, 1-based lines, sha256 of the node text and of the file. */
function provenance(rel, symbol, node, extra = {}) {
  const sf = parse(rel);
  return { file: rel, symbol, startLine: lineOf(sf, node.getStart(sf)), endLine: lineOf(sf, node.getEnd()), sha256: sha256(Buffer.from(node.getText(sf), 'utf8')), fileSha256: sources[rel], ...extra };
}
function find(root, pred) {
  let hit = null;
  (function walk(n) { if (!hit && pred(n)) hit = n; if (!hit) ts.forEachChild(n, walk); })(root);
  return hit;
}
const findAll = (root, pred) => { const out = []; (function walk(n) { if (pred(n)) out.push(n); ts.forEachChild(n, walk); })(root); return out; };
const unwrap = (n) => (n && (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isSatisfiesExpression?.(n)) ? unwrap(n.expression) : n);
const prop = (obj, name) => obj.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name.getText() === name);
const calls = (node, name) => findAll(node, (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name);

// octo_management: factory, enum and plugin registration
const tools = parse('src/agent-tools.ts');
const factory = find(tools, (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'createOctoManagementTools');
if (!factory) fail('createOctoManagementTools not found in B src/agent-tools.ts');
const actionProp = find(factory, (n) => ts.isPropertyAssignment(n) && n.name.getText() === 'action' && ts.isObjectLiteralExpression(n.initializer) && prop(n.initializer, 'enum'));
const enumProp = actionProp && prop(actionProp.initializer, 'enum');
const management = enumProp && stringArray(enumProp.initializer);
if (!management) fail('octo_management action enum not found inside createOctoManagementTools');
const index = parse('index.ts');
const registerCall = find(index, (n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'registerTool'
  && n.arguments.length === 2 && ts.isObjectLiteralExpression(n.arguments[1]) && stringArray(prop(n.arguments[1], 'names')?.initializer ?? ts.factory.createNull())?.includes('octo_management'));
if (!registerCall || calls(registerCall.arguments[0], 'createOctoManagementTools').length !== 1) fail('api.registerTool(octo_management) → createOctoManagementTools not found in B index.ts');

// advertised message actions: getAvailableActions, consumed by octoPlugin.actions.listActions/describeMessageTool
const channel = parse('src/channel.ts');
const advertiser = find(channel, (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'getAvailableActions');
const advertisedReturn = advertiser && find(advertiser, (n) => ts.isReturnStatement(n) && n.expression && stringArray(n.expression)?.length > 0);
const messageActions = advertisedReturn && stringArray(advertisedReturn.expression);
if (!messageActions) fail('getAvailableActions advertised action list not found in B src/channel.ts');
const pluginDecl = find(channel, (n) => ts.isVariableDeclaration(n) && n.name.getText() === 'octoPlugin');
const pluginObj = unwrap(pluginDecl?.initializer);
const actionsProp = pluginObj && ts.isObjectLiteralExpression(pluginObj) ? prop(pluginObj, 'actions') : null;
const actionsObj = unwrap(actionsProp?.initializer);
if (!actionsObj || !ts.isObjectLiteralExpression(actionsObj)) fail('octoPlugin.actions not found in B src/channel.ts');
const members = {};
for (const m of ['listActions', 'describeMessageTool', 'handleAction']) {
  const p = prop(actionsObj, m);
  if (!p) fail(`octoPlugin.actions.${m} not found`);
  members[m] = lineOf(channel, p.getStart(channel));
  if (m !== 'handleAction' && calls(p, 'getAvailableActions').length !== 1) fail(`octoPlugin.actions.${m} does not advertise via getAvailableActions`);
}
const dispatchCalls = calls(prop(actionsObj, 'handleAction'), 'handleOctoMessageAction');
if (dispatchCalls.length !== 1) fail('octoPlugin.actions.handleAction must call handleOctoMessageAction exactly once');

// reachable message routes: the handleOctoMessageAction switch(action)
const actionsSf = parse('src/actions.ts');
const dispatcher = find(actionsSf, (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'handleOctoMessageAction');
const sw = dispatcher && find(dispatcher.body, (n) => ts.isSwitchStatement(n) && n.expression.getText() === 'action');
if (!sw) fail('handleOctoMessageAction switch(action) not found in B src/actions.ts');
const messageRoutes = [];
let defaultRejectsUnknown = false;
for (const clause of sw.caseBlock.clauses) {
  if (ts.isDefaultClause(clause)) {
    defaultRejectsUnknown = clause.statements.length === 1 && ts.isReturnStatement(clause.statements[0]) && /ok:\s*false/.test(clause.statements[0].getText()) && /Unknown action/.test(clause.statements[0].getText());
    continue;
  }
  if (!ts.isStringLiteral(clause.expression)) fail(`non-literal case in handleOctoMessageAction: ${clause.expression.getText()}`);
  const ret = clause.statements[0];
  const call = ret && ts.isReturnStatement(ret) && ret.expression && ts.isCallExpression(ret.expression) ? ret.expression : null;
  if (clause.statements.length !== 1 || !call || !ts.isIdentifier(call.expression)) fail(`case "${clause.expression.text}" is not a single handler return`);
  const arg = call.arguments[0];
  const handlerArgs = arg && ts.isObjectLiteralExpression(arg) ? arg.properties.map((p) => p.name.getText()) : [];
  messageRoutes.push({
    action: clause.expression.text, file: 'src/actions.ts', symbol: 'handleOctoMessageAction',
    caseLine: lineOf(actionsSf, clause.getStart(actionsSf)), returnLine: lineOf(actionsSf, ret.getStart(actionsSf)),
    handler: call.expression.text, handlerArgs, advertised: messageActions.includes(clause.expression.text),
  });
}
if (new Set(messageRoutes.map((r) => r.action)).size !== messageRoutes.length) fail('duplicate handleOctoMessageAction case');
for (const a of messageActions) if (!messageRoutes.some((r) => r.action === a)) fail(`advertised action ${a} has no dispatcher route`);
for (const a of messageActions) if (management.includes(a)) fail(`advertised message action ${a} overlaps octo_management`);

const actions = {
  generator: 'scripts/goldens/gen-b.mjs',
  source: { repo: 'Mininglamp-OSS/openclaw-channel-octo', commit: pins.B, file: 'src/agent-tools.ts', sha256: sources['src/agent-tools.ts'] },
  messageSource: { file: 'src/channel.ts', sha256: sources['src/channel.ts'] },
  actions: management,
  messageActions,
  amendment: AMENDMENT,
  sources: Object.fromEntries(['index.ts', 'src/actions.ts', 'src/agent-tools.ts', 'src/channel.ts'].map((f) => [f, sources[f]])),
  ownership: {
    managementFactory: provenance('src/agent-tools.ts', 'createOctoManagementTools', factory),
    managementEnum: provenance('src/agent-tools.ts', 'createOctoManagementTools > parameters.properties.action.enum', enumProp),
    managementRegistration: provenance('index.ts', 'registerFull > api.registerTool(octo_management)', registerCall, { names: ['octo_management'], factoryCall: 'createOctoManagementTools' }),
    messageAdvertisement: provenance('src/channel.ts', 'getAvailableActions', advertiser, { returnLine: lineOf(channel, advertisedReturn.getStart(channel)), actions: messageActions }),
    messageRegistration: provenance('src/channel.ts', 'octoPlugin.actions', actionsProp, { members, dispatchCall: 'handleOctoMessageAction', dispatchCallLine: lineOf(channel, dispatchCalls[0].getStart(channel)) }),
    messageDispatcher: provenance('src/actions.ts', 'handleOctoMessageAction', dispatcher, { defaultRejectsUnknown }),
  },
  messageRoutes,
  note: 'Two disjoint public surfaces in the pinned source (A-R8-PM05-01): 24 octo_management actions and 3 advertised message actions (getAvailableActions). Message dispatch reaches 8 handleOctoMessageAction routes, including the advertised 3. R8 §4 O24/§9 DEV-14 originally stated 27 management actions.',
};

const outputs = { 'wire-aes-framing.json': wire, 'management-actions.json': actions };
let drift = false;
for (const [name, value] of Object.entries(outputs)) {
  const text = JSON.stringify(value, null, 2) + '\n';
  const digest = `${sha256(Buffer.from(text, 'utf8'))}  ${name}\n`;
  if (CHECK) {
    const cur = readFileSync(join(OUT, name), 'utf8');
    const curSum = readFileSync(join(OUT, `${name}.sha256`), 'utf8');
    if (cur !== text || curSum !== digest) { console.error(`gen-b --check: ${name} differs from regenerated output`); drift = true; }
    else console.log(`gen-b --check: ${name} reproduced (${digest.split(' ')[0]})`);
  } else {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, name), text);
    writeFileSync(join(OUT, `${name}.sha256`), digest);
    console.log(`gen-b: wrote test/goldens/b/${name} ${digest.split(' ')[0]}`);
  }
}
rmSync(bundlePath, { force: true });
if (drift) process.exit(1);
