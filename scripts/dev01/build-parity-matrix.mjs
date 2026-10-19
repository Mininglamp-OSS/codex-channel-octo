// Author tool for test/parity-matrix.json and the named pending contract files
// test/contracts/*.contract.test.ts (R8 §4 SF-5).
//   node scripts/dev01/build-parity-matrix.mjs <path/to/r8.md>
// Row text, dispositions and stages are parsed from R8 §§4–5 and the §7.1/§1.2
// invariant lists; test references for implemented behavior come from the
// explicit TESTS map below (each must resolve, enforced by the validator).
// Everything not yet implemented references a named it.todo contract in its
// DEV stage file: pending, never passing. Run from the repo root.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const r8 = readFileSync(process.argv[2], 'utf8');
const mgmt = JSON.parse(readFileSync('test/goldens/b/management-actions.json', 'utf8'));

function table(startMarker, endMarker) {
  const a = r8.indexOf(startMarker);
  const b = r8.indexOf(endMarker, a + startMarker.length);
  if (a < 0 || b < 0) throw new Error(`section not found: ${startMarker}`);
  return r8.slice(a, b).split('\n').filter((l) => l.startsWith('|') && !l.startsWith('|---'))
    .map((l) => l.trim().replace(/^\||\|$/g, '').replace(/\\\|/g, '\u0000').split('|').map((c) => c.split('\u0000').join('|').trim()));
}

const L = 'test/locks/reuse-locks.test.ts#';
const BXF = 'test/locks/bx-locks.test.ts#BX locks (B defects not ported) > ';
const INV = 'test/locks/invariant-locks.test.ts#';
const D1 = 'test/locks/dev01-capability-locks.test.ts#';
const FO = 'test/integration/fake-octo-transport.test.ts#fake Octo WS: production WKSocket handshake and delivery > ';
const EPW = 'test/integration/fake-octo-transport.test.ts#fake Octo REST: endpoint wire inventory for existing A endpoints > ';
const GB = 'test/goldens/b-wire.golden.test.ts#';
const GOC = 'test/goldens/oc-schedule.golden.test.ts#';
const A_ = 'src/__tests__/';

const T = {
  T11: `${L}transport locks > T11: a server DISCONNECT kicks the socket and the gateway re-registers with force_refresh then reconnects`,
  T23: `${L}transport locks > T23: ordinary self echoes are dropped at the gateway, but own preference/markdown events still pass`,
  R4: `${L}REST client locks > R4: 16+ digit message_id values survive JSON parsing as exact decimal strings`,
  R5: `${L}REST client locks > R5: messages/sync is capped to the requested count and oversized base64 payloads are dropped undecoded`,
  EP13: `${L}REST client locks > EP-13: group members GET encodes the group number and accepts {members:[]} or a bare array`,
  I1: `${L}inbound locks > I1: DM (1), group (2) and community topic (5) are the conversation channel types`,
  I4: `${L}inbound locks > I4: DM session keys carry the space id parsed from s<space>_<uid> uids or compound channel ids`,
  I9: `${L}inbound locks > I9: a DM is processed without any mention`,
  I26: `${L}inbound locks > I26: RichText prefers server plain, else renders text blocks and [图片] placeholders, and collects image URLs`,
  I29: `${L}inbound locks > I29: control events are consumed by the router and never become a turn, even when @-mentioning the bot`,
  S7: `${L}session/history locks > S7: history is captured per session with sanitized speaker labels, escaped forged role lines and chronological order`,
  S14: `${L}session/history locks > S14: operator group instructions load from <groupConfigDir>/<id>.md, refuse unsafe ids/permissions, and land in the system text`,
  O2: `${L}outbound locks > O2: markdown is sent raw (no conversion or escaping)`,
  O10: `${L}outbound locks > O10: @all / @所有人 sets mention.all on the first segment only`,
  EP28: `${L}outbound locks > EP-28: WS md/pref events — only a self-authored mention_pref_updated invalidates the cached preference`,
  BX1: `${BXF}BX-1: RECVACK is never written before a successful decrypt + parse`,
  BX2: `${BXF}BX-2: a 1 MiB+ partial frame closes the link and a large frame parses without argument spreads`,
  BX3: `${BXF}BX-3 / T5: the DH seed is CSPRNG-derived — fixing Math.random does not repeat the client key`,
  BX4: `${BXF}BX-4: inbound media URLs are host-allowlisted, traversal-checked and SSRF-guarded before any credentialed fetch`,
  BX5: `${BXF}BX-5: group numbers and short ids are percent-encoded in every ported path (no traversal)`,
  BX6: `${BXF}BX-6 / O9: a structured mention of a non-member uid is downgraded to plain text, never sent as a uid`,
  BX7: `${BXF}BX-7 / I12: a member without an explicit robot=0 flag is never treated as a human for mention-free admission`,
  BX8: `${BXF}BX-8 / I13: mention_pref_updated from another sender does not invalidate the preference cache`,
  BX9: `${BXF}BX-9 / S13: group context lines cannot forge role labels or section markers once assembled for the prompt`,
  BX10: `${BXF}BX-10 / I24: inlined file content cannot forge the closing delimiter`,
  BX11: `${BXF}BX-11 / I35: a card-action event cannot trigger anything at A (no unauthenticated card intake exists)`,
  BX11todo: `${BXF}BX-11 / I35 (DEV-13): card actions are authorized per operator uid when the intake is ported`,
  BX12: `${BXF}BX-12: the empty-turn placeholder keeps A wording and the B host placeholder is not ported`,
  GB01: `${GB}T1/T2/T3: A Encoder/Decoder vs B > GB-01: A Encoder produces the B bytes for every primitive vector (incl. CJK, emoji, empty, int64)`,
  GB02: `${GB}T1/T2/T3: A Encoder/Decoder vs B > GB-02: A Decoder reads back the encoded primitives`,
  GB03: `${GB}T1/T2/T3: A Encoder/Decoder vs B > GB-03 (BX-2): B silently over-reads truncated input; A raises a typed bounds error instead`,
  GB04: `${GB}P1 handshake and AES vs B (production WKSocket through the fake server) > GB-04 (T1/T3/T5): A CONNECT equals the B CONNECT frame byte-for-byte for identical inputs`,
  GB05: `${GB}P1 handshake and AES vs B (production WKSocket through the fake server) > GB-05 (T6): the B AES key/IV/ciphertext vectors satisfy the P1 derivation independently`,
  GB06: `${GB}P1 handshake and AES vs B (production WKSocket through the fake server) > GB-06 (T9/T10/BX-1): A decodes every B RECV vector to the B message and ACKs with the B RECVACK bytes only after decrypt`,
  FO01: `${FO}FO-01: register + CONNECT carry the pinned protocol fields and the bot identity`,
  FO02: `${FO}FO-02: RECV is decrypted, delivered with full int64 precision, and ACKed only after a successful parse`,
  FO03: `${FO}FO-03: a poison payload is not ACKed until the third delivery and never reaches the handler`,
  FO04: `${FO}FO-04: a CONNACK salt shorter than 16 bytes fails the handshake (client closes, nothing delivered)`,
  FO05: `${FO}FO-05: DISCONNECT triggers the existing kick → force_refresh re-register → reconnect path`,
  FO07: `${FO}FO-07: api.forceStatus(register,503) fails register() and releases the per-bot lock`,
  EP03: `${EPW}EP-03.send: sendMessage posts type-1 payload, mention block and a fresh client_msg_no`,
  EP02: `${EPW}EP-02/EP-09/EP-10: heartbeat, typing and read receipt wire shapes`,
  EP19: `${EPW}EP-19.get: user/info encodes the uid, maps 200 and returns null on 404`,
  EP14: `${EPW}EP-13.get / EP-14.get / EP-15.get / EP-16.get: group reads encode path segments`,
  EP11: `${EPW}EP-11.sync: messages/sync request body and base64 payload decoding`,
  EP21: `${EPW}EP-21.get: upload/credentials encodes the filename and scrubs Bearer tokens from error text`,
  T12a: `${D1}T12 / T15 transport timers (A@dd12980 behavior) > T12: after CONNACK a PING is sent every 60 s; three unanswered pings close and reconnect on the fourth tick`,
  T12b: `${D1}T12 / T15 transport timers (A@dd12980 behavior) > T12: a PONG resets the unanswered-ping counter`,
  T15a: `${D1}T12 / T15 transport timers (A@dd12980 behavior) > T15: three consecutive sub-5 s connections stop reconnecting and surface a rapid-disconnect error`,
  T15b: `${D1}T12 / T15 transport timers (A@dd12980 behavior) > T15: a connection that stays up 30 s resets the backoff to the base delay`,
  I3: `${D1}I3 / S2 topic and group sessions > I3: a topic id <group>____<short> is its own session, distinct from its parent group, and resolves its parent group number`,
  S2: `${D1}I3 / S2 topic and group sessions > S2: every member of a group or topic shares one session key; DMs stay per peer`,
  P1: `${INV}INV-P1 protocol constants > INV-P1: CONNECT carries PROTO_VERSION=4, deviceFlag=0, a W-suffixed deviceID; AES-128-CBC key=MD5(base64(shared))[0:16], IV=salt[0:16]`,
  P2: `${INV}INV-P2 transport hardening > INV-P2: a remaining-length varint longer than 4 bytes is rejected and the link closed`,
  P3: `${INV}INV-P3 delivery > INV-P3: ACK only after decrypt+parse; a poison message is ACK-dropped at the third failure`,
  P4: `${INV}INV-P4 liveness > INV-P4: a kicked CONNACK (reason 0) closes the socket and surfaces the kick for token refresh`,
  P5a: `${INV}INV-P5 URL policy > INV-P5: plaintext ws:// to a non-loopback host is refused before any socket opens`,
  P5b: `${INV}INV-P5 URL policy > INV-P5: every redirect hop is SSRF-checked, at most 10 hops are followed, and credentials can be scoped per hop`,
  P6: `${INV}INV-P6 inbound gating > INV-P6: an unmentioned bot never passes in a group, a forged cron marker without the nonce is gated, text > 32 KB is rejected`,
  P7: `${INV}INV-P7 prompt safety > INV-P7: the 96 KB user payload cap preserves the current message body over injected context`,
  P8: `${INV}INV-P8 agent sandbox > INV-P8: read-only is the default and workspace-write needs the second switch`,
  P9: `${INV}INV-P9 secrets > INV-P9: the bot token never enters the Codex child environment or the /config reply`,
  C1: `${INV}INV-C compatibility > INV-C1: top-level "_" keys are stripped, bot ids are case-sensitive path segments, and unsafe ids are rejected`,
  C2: `${INV}INV-C compatibility > INV-C2: the guarded additive migration upgrades a legacy messages table without data loss`,
  C3: `${INV}INV-C compatibility > INV-C3: per-session cwd names are byte-stable sha256(kind:key)[0:16] partitions`,
  C4: `${INV}INV-C compatibility > INV-C4: /reset deletes the session, raises the monotonic barrier and clears the thread mapping with its document state`,
  C5: `${INV}INV-C compatibility > INV-C5: the gateway lock is atomic, nonce-guarded and never released by another instance`,
  C6: `${INV}INV-C compatibility > INV-C6: CODEX_HOME, DB, cwd and lock directories default to per-bot subtrees`,
  B1: `${INV}hard boundaries (R8 §1.2) > HB-B1: per-bot data/cwd/codex-home isolation holds at the configuration layer today`,
  B3: `${INV}hard boundaries (R8 §1.2) > HB-B3: sdk_sessions is the only sessionKey → thread map in the baseline schema`,
  B8: `${INV}hard boundaries (R8 §1.2) > HB-B8: no OpenClaw framework or axios dependency or import`,
  EG02: 'test/egress/egress-bypass-scan.test.ts#egress bypass scan: repository at DEV-01 > EG-02: the observed outbound call sites equal the explicit baseline exactly (no new caller, no stale entry)',
  DG03: "test/downgrade/downgrade-open.test.ts#downgrade-open harness > DG-03: with the head's actual migration list (empty at DEV-01) the dd12980 build reopens the DB and runs its core paths",
  CI01: 'test/ci/ci-workflow.test.ts#CI workflow > CI-01: push and pull_request on all branches plus workflow_dispatch',
  CI03: 'test/ci/ci-workflow.test.ts#CI workflow > CI-03: the R8 §10.2 jobs exist with their commands',
  GOC01: `${GOC}CR-2.3 DST contract: generated values equal the R8 §3.4.6 verbatim table > GOC-01 $id`,
  GOC05: `${GOC}CR-2.6 effective stagger (R8 §3.4.8) > GOC-05 (STAG arithmetic): j7f3k2q/300000 → 253353 via uint32BE of the first four digest bytes, not the whole digest`,
  GOC07: `${GOC}CR-2.6 effective stagger (R8 §3.4.8) > GOC-07: the R8 §3.4.8 boundary walk-through is reproduced by the pinned effective wrappers`,
  // pre-existing A tests (unchanged files) that already lock REUSE behavior
  mentionFree: `${A_}g3-g8-g12-g13.test.ts#G12: Mention-free groups > processes group message without @mention when group is mention-free`,
  rateLimit: `${A_}session-router.test.ts#SessionRouter > rejects requests exceeding rate limit`,
  serial: `${A_}session-router.test.ts#routeAndHandle concurrency > same session key: route + handler execute serially (FIFO)`,
  voiceVideo: `${A_}inbound.test.ts#resolveContent: GIF / Voice / Video / File > Voice (G22: URL marker only, transcription TBD)`,
  imageDl: `${A_}media-inbound.test.ts#downloadInboundImage > downloads a PNG into <cwd>/.cc-octo-media and returns a relative path`,
  imageCap: `${A_}media-inbound.test.ts#downloadInboundImage > rejects an oversize image and deletes the partial file`,
  split: `${A_}stream-relay.test.ts#splitMessage > splits at newline when no paragraph break`,
  partialFlush: `${A_}stream-relay.test.ts#StreamRelay > flushes partial output and re-throws when the source iterable throws mid-stream`,
  cfgDefaults: `${A_}config.test.ts#loadConfig defaults > returns correct shared defaults; baseDir = config dir; dirs derived per bot`,
  cfgApi: `${A_}config.test.ts#resolveBotConfigs (two-layer) > rejects an unsafe per-bot apiUrl override`,
  cfgFile: `${A_}config.test.ts#config-file over defaults > file overrides defaults`,
  mdApi: `${A_}conversation-md-api.test.ts#conversation markdown API contract > accepts absent document content and version zero`,
};

// row id → existing references (implemented behavior)
const REFS = {
  T1: [T.GB01, T.GB04, T.P1], T2: [T.GB01, T.GB02, T.GB03], T3: [T.GB04, T.P2], T4: [T.BX2], T5: [T.BX3, T.GB04], T6: [T.GB05, T.P1],
  T7: [T.FO04], T9: [T.GB06, T.FO02], T10: [T.FO02, T.FO03, T.BX1, T.P3], T11: [T.T11, T.FO05], T12: [T.T12a, T.T12b], T15: [T.T15a, T.T15b],
  T21: [T.P5a], T23: [T.T23], R4: [T.R4], R5: [T.R5], R6: [T.BX5], 'EP-01': [T.FO01, T.FO07], 'EP-02': [T.EP02], 'EP-03': [T.EP03],
  'EP-09': [T.EP02], 'EP-10': [T.EP02], 'EP-11': [T.EP11], 'EP-13': [T.EP13, T.EP14], 'EP-14': [T.EP14, T.EP28], 'EP-15': [T.EP14], 'EP-16': [T.EP14, T.mdApi],
  'EP-19': [T.EP19], 'EP-21': [T.EP21], 'EP-28': [T.EP28],
  I1: [T.I1], I2: [T.I1], I3: [T.I3], I4: [T.I4], I9: [T.I9], I10: [T.mentionFree], I12: [T.BX7], I13: [T.BX8], I15: [T.T23, T.P6], I17: [T.P6, T.rateLimit],
  I18: [T.serial], I21: [T.imageDl, T.imageCap], I22: [T.voiceVideo], I23: [T.voiceVideo], I24: [T.BX10], I26: [T.I26], I29: [T.I29], I31: [T.BX4], I32: [T.BX4], I33: [T.BX9, T.S7],
  S1: [T.I4], S2: [T.S2], S4: [T.C3], S5: [T.B3, T.C4], S7: [T.S7], S13: [T.BX9, T.mdApi], S14: [T.S14], S16: [], C2: [T.B1], C6: [T.C4], C12: [T.C5], C16: [T.CI01, T.CI03],
  O1: [T.EP03], O2: [T.O2], O3: [T.split], O5: [T.partialFlush], O6: [T.BX6], O9: [T.BX6], O10: [T.O10],
  'K-01': [T.C1], 'K-02': [T.cfgApi], 'K-07': [T.cfgDefaults], 'K-09': [T.cfgDefaults],
  'KA-1': [T.C1], 'KA-2': [T.S14], 'KA-3': [T.C6], 'KA-4': [T.rateLimit], 'KA-5': [T.cfgDefaults], 'KA-6': [T.cfgFile], 'KA-7': [T.mentionFree],
  'CR-2.3': [T.GOC01], 'CR-2.6': [T.GOC05, T.GOC07],
  'BX-1': [T.BX1, T.GB06], 'BX-2': [T.BX2, T.GB03], 'BX-3': [T.BX3], 'BX-4': [T.BX4], 'BX-5': [T.BX5], 'BX-6': [T.BX6], 'BX-7': [T.BX7], 'BX-8': [T.BX8],
  'BX-9': [T.BX9], 'BX-10': [T.BX10], 'BX-11': [T.BX11, T.BX11todo], 'BX-12': [T.BX12],
  'INV-P1': [T.P1, T.GB04, T.GB05], 'INV-P2': [T.P2, T.BX2, T.BX3, T.GB03, T.FO04], 'INV-P3': [T.P3, `${INV}INV-P3 delivery > INV-P3 (DEV-08): intake stops (no further RECVACK) before handler drain at shutdown`],
  'INV-P4': [T.P4, `${INV}INV-P4 liveness > INV-P4 (DEV-02): every needReconnect=false path hands off to refresh, deferred reconnect or the watchdog`, `${INV}INV-P4 liveness > INV-P4 (DEV-02): REST heartbeat failures never tear down the socket (429 counted separately)`, `${INV}INV-P4 liveness > INV-P4 (DEV-02): stopped is re-checked after every await; a failed CONNACK closes and nulls the ws; a fired reconnect timer nulls its handle`],
  'INV-P5': [T.P5a, T.P5b, T.BX4, `${INV}INV-P5 URL policy > INV-P5 (DEV-02): the wss policy is also applied on token-refresh reconnects and the wsUrl override`],
  'INV-P6': [T.P6, T.I1, T.T23, T.BX7, T.BX8, T.I29], 'INV-P7': [T.P7, T.BX9, T.BX10],
  'INV-P8': [T.P8, `${INV}INV-P8 agent sandbox > INV-P8 (DEV-03/04): every App Server server request is answered with the exec-parity decline under approval never`],
  'INV-P9': [T.P9, T.EP21, `${INV}INV-P9 secrets > INV-P9 (DEV-02): every REST error body is capped at 500 chars and Bearer-scrubbed (postJson/getJson today return the raw body)`],
  'INV-P10': [`${INV}INV-P10 authorization for ported tools > INV-P10 (DEV-14/16): cross-channel reads use checkPermission against the trusted requester; task turns use entry allowlists and the egress chokepoint`],
  'INV-C1': [T.C1], 'INV-C2': [T.C2, T.DG03], 'INV-C3': [T.C3, T.I4], 'INV-C4': [T.C4], 'INV-C5': [T.C5, T.FO07], 'INV-C6': [T.C6],
  'HB-B1': [T.B1, `${INV}hard boundaries (R8 §1.2) > HB-B1 (DEV-04): each bot owns its own codex app-server child, -c overrides and auth; two-bot no-cross-talk`],
  'HB-B2': [`${INV}hard boundaries (R8 §1.2) > HB-B2 (DEV-04): queryAgent stays byte-compatible across both executors (agent-bridge.test.ts 48 cases green against the App Server executor)`],
  'HB-B3': [T.B3, `${INV}hard boundaries (R8 §1.2) > HB-B3 (DEV-06): thread-map writes are compare-and-set against the reset generation`],
  'HB-B4': [`${INV}hard boundaries (R8 §1.2) > HB-B4 (DEV-04): at most one active turn per thread per process generation; lanes release only on matching terminal or confirmed exit`],
  'HB-B5': [T.EG02, `${INV}hard boundaries (R8 §1.2) > HB-B5 (DEV-06): every Octo message/control write goes through OctoEgress (the egress bypass scan baseline shrinks to zero permitted callers)`],
  'HB-B6': [T.DG03, `${INV}hard boundaries (R8 §1.2) > HB-B6 (DEV-02): migrations run only while the ownership lock is held (today the DB opens before register() takes the lock)`],
  'HB-B7': [`${INV}hard boundaries (R8 §1.2) > HB-B7 (DEV-03/04): every App Server server request is answered (real-binary SB-07 proves the parity reply shape)`],
  'HB-B8': [T.B8], 'HB-B9': [T.T11, T.BX1, T.BX2, T.P1, T.C5],
  'HB-B10': [`${INV}hard boundaries (R8 §1.2) > HB-B10 (DEV-10): cron-origin input is never command-parsed and reminders bypass the router`],
  'HB-B11': [`${INV}hard boundaries (R8 §1.2) > HB-B11 (DEV-09/10): every run finalizer is fenced by job generation`],
};

const rows = [];
const contracts = new Map(); // file → titles
function stageOf(text) {
  const m = [...String(text).matchAll(/DEV-(\d+)/g)].map((x) => `DEV-${x[1].padStart(2, '0')}`);
  if (m.length) return [...new Set(m)];
  if (/\block\b/.test(text)) return ['lock'];
  return ['—'];
}
function dispositionCode(d) {
  d = d.replace(/\*\*/g, '').trim();
  if (/^GET REUSE/.test(d) || /^as EP-15/.test(d)) return 'REUSE'; // EP-16 "as EP-15": GET REUSE; PUT TIER-OD
  if (/^M1: REUSE/.test(d)) return 'ADAPT'; // O19: M1 reuse + M3 TIER-OD replacement
  if (/^NA-OD|^NA \(|^NA$|^NA\b/.test(d)) return /OD-/.test(d) ? 'NA-OD' : 'NA';
  if (/^TIER-OD/.test(d)) return 'TIER-OD';
  if (/^SPIKE/.test(d)) return 'SPIKE';
  if (/^REWRITE/.test(d)) return 'REWRITE';
  if (/^ADAPT/.test(d)) return 'ADAPT';
  if (/^REUSE/.test(d)) return 'REUSE';
  if (/^PRESERVE/.test(d)) return 'PRESERVE';
  if (/^GAP-OD/.test(d)) return 'GAP-OD';
  if (/^accept and ignore/.test(d)) return 'ADAPT';
  return d.split(/[ (;,]/)[0] || 'ADAPT';
}
const tierOf = (stages, disp) => {
  const n = stages.map((s) => Number(s.slice(4))).filter(Boolean);
  if (disp === 'TIER-OD' && n.some((x) => x >= 16)) return 'C';
  if (disp === 'TIER-OD' || n.some((x) => x >= 12)) return n.some((x) => x >= 16) ? 'C' : 'B';
  if (n.some((x) => x >= 9 && x <= 11)) return 'M2';
  return 'A';
};
function contractFile(stage) {
  const s = /^DEV-\d\d$/.test(stage) ? stage.toLowerCase() : 'dev-01';
  return `test/contracts/${s}.contract.test.ts`;
}
function addContract(id, stage, text) {
  const file = contractFile(stage);
  const title = `${id} (${stage}): ${text.replace(/\s+/g, ' ').replace(/'/g, '’').slice(0, 220)}`;
  const describe = `${stage} pending contracts`;
  if (!contracts.has(file)) contracts.set(file, { describe, titles: [] });
  contracts.get(file).titles.push(title);
  return `${file}#${describe} > ${title}`;
}
const decisionOf = (text) => (String(text).match(/OD-\d+[a-z]?/g) ?? [])[0];

function push(row) {
  const real = REFS[row.id] ?? [];
  const excluded = ['NA', 'NA-OD', 'GAP-OD'].includes(row.disposition);
  const futureStage = row.stage.find((s) => /^DEV-\d\d$/.test(s) && s !== 'DEV-01');
  let impl;
  if (excluded) impl = 'not-applicable';
  else if (['REUSE'].includes(row.disposition) && !futureStage) impl = 'implemented';
  else if (row.kind === 'bx') impl = row.id === 'BX-11' ? 'partial' : 'implemented';
  else if (real.length && futureStage) impl = 'partial';
  else if (real.length && row.kind === 'invariant') impl = real.some((r) => /\(DEV-\d/.test(r)) ? 'partial' : 'implemented';
  else if (real.length && row.disposition === 'REUSE') impl = 'implemented';
  else impl = 'pending';
  if (row.kind === 'invariant' && !real.some((r) => !/\(DEV-\d/.test(r))) impl = 'pending';
  const tests = [...real];
  if (!excluded && impl !== 'implemented' && !(row.kind === 'invariant' || row.kind === 'bx')) {
    tests.push(addContract(row.id, futureStage ?? row.stage.find((s) => /^DEV/.test(s)) ?? 'DEV-01', row.title));
  }
  rows.push({
    ...row, tests, implementationStatus: impl, executionStatus: 'not-run',
    owner: row.owner ?? 'backend-dev', layer: row.layer ?? (row.kind === 'cron' ? 'unit+fake-clock' : 'unit/fake-server'),
    fixture: row.fixture ?? '', evidence: '',
    decision: excluded ? (decisionOf(row.dispositionNote) ?? (row.disposition === 'GAP-OD' ? 'OD-31' : '')) : (decisionOf(row.dispositionNote) ?? ''),
    gap: impl === 'implemented' ? '' : (excluded ? 'approved scope exclusion' : `pending ${futureStage ?? row.stage.join('/')}${impl === 'partial' ? ' (baseline behavior locked; remaining work pending)' : ''}`),
  });
}

// §4.1, §4.3, §4.4, §4.6 (ID | Capability | A status | Disposition | Stage | Notes)
for (const [a, b] of [['### 4.1 Transport', '### 4.2'], ['### 4.3 Inbound', '### 4.4'], ['### 4.4 Sessions', '### 4.5'], ['### 4.6 Outbound', '### 4.7']]) {
  for (const c of table(a, b)) {
    if (!/^(T|I|S|O)\d+$/.test(c[0])) continue;
    const stage = stageOf(c[4]);
    const disp = dispositionCode(c[3]);
    push({ id: c[0], kind: 'capability', title: c[1], acceptance: `${c[3]}${c[5] ? ` — ${c[5]}` : ''}`, disposition: disp, dispositionNote: c[3], aStatus: c[2], stage, tier: tierOf(stage, disp) });
  }
}
// §4.2 R rows and EP rows; §4.5 C rows (ID | Capability | A status | Disposition | Stage)
for (const c of [...table('### 4.2 REST client', '| EP | Endpoint'), ...table('| EP | Endpoint', '### 4.3'), ...table('### 4.5 Configuration', '### 4.6')]) {
  if (!/^(R|C)\d+$|^EP-\d\d$/.test(c[0])) continue;
  const stage = stageOf(c[4]);
  const disp = dispositionCode(c[3]);
  push({ id: c[0], kind: 'capability', title: c[1], acceptance: c[3], disposition: disp, dispositionNote: c[3], aStatus: c[2], stage, tier: tierOf(stage, disp) });
}
// §4.7 config keys
for (const c of table('### 4.7 Configuration key ledger', '### 4.8')) {
  const ids = c[0] === 'KA-1..7' ? Array.from({ length: 7 }, (_, i) => `KA-${i + 1}`) : /^K-\d\d$/.test(c[0]) ? [c[0]] : [];
  for (const id of ids) {
    const disp = dispositionCode(c[3]);
    const stage = /K-0[13589]|K-1[06]|KA/.test(id) ? (/REUSE/.test(c[3]) && !/R8|warn/.test(c[3]) ? ['—'] : ['DEV-08']) : /TIER-OD/.test(c[3]) ? (/Tier C/.test(c[3]) ? ['DEV-16'] : ['DEV-13']) : /SPIKE/.test(c[3]) ? ['DEV-12'] : ['DEV-08'];
    push({ id, kind: 'config-key', title: `${c[1]} (A: ${c[2]})`, acceptance: c[3], disposition: id === 'K-17' ? 'NA' : disp, dispositionNote: c[3], aStatus: c[2], stage, tier: tierOf(stage, disp) });
  }
}
// §4.8 BX
for (const c of table('### 4.8 B defects not to port', 'The [XIN-2041]')) {
  if (!/^BX-\d+$/.test(c[0])) continue;
  push({ id: c[0], kind: 'bx', title: c[1], acceptance: c[2], disposition: 'NOT-PORTED', dispositionNote: c[2], aStatus: 'A blocks the defect', stage: ['DEV-01'], tier: 'A' });
}
// §5 CR rows
for (const [a, b] of [['### 5.1 Job model', '### 5.2'], ['### 5.2 Schedules', '### 5.3'], ['### 5.3 Persistence', '### 5.4'], ['### 5.4 Concurrency', '### 5.5'], ['### 5.5 Execution', '### 5.6'], ['### 5.6 Delivery', '### 5.7'], ['### 5.7 Management', '### 5.8'], ['### 5.8 Security', '### 5.9']]) {
  for (const c of table(a, b)) {
    if (!/^CR-\d\.\d$/.test(c[0])) continue;
    const disp = dispositionCode(c[2]);
    const stage = /^CR-[123]\./.test(c[0]) ? ['DEV-09'] : /^CR-7\./.test(c[0]) ? ['DEV-11'] : ['DEV-10'];
    push({ id: c[0], kind: 'cron', title: c[1], acceptance: `${c[2]}${c[3] ? ` — ${c[3]}` : ''}`, disposition: disp, dispositionNote: `${c[2]} ${c[3] ?? ''}`, aStatus: 'orphaned cron marker only (no producer)', stage, tier: 'M2' });
  }
}
// invariants
const P_TITLES = ['Protocol constants', 'Transport hardening (from A)', 'Delivery', 'Liveness', 'URL policy', 'Inbound gating', 'Prompt safety', 'Agent sandbox', 'Secrets', 'Authorisation for ported tools'];
P_TITLES.forEach((t, i) => push({ id: `INV-P${i + 1}`, kind: 'invariant', title: `P${i + 1}. ${t}`, acceptance: 'R8 §7.1 release gate', disposition: 'INVARIANT', dispositionNote: 'R8 §7.1', aStatus: 'see locks', stage: ['DEV-01'], tier: 'A' }));
['Config', 'SQLite', 'Session continuity', '/reset semantics', 'CLI', 'Per-bot isolation'].forEach((t, i) => push({ id: `INV-C${i + 1}`, kind: 'invariant', title: `C${i + 1}. ${t}`, acceptance: 'R8 §7.1 compatibility gate', disposition: 'INVARIANT', dispositionNote: 'R8 §7.1', aStatus: 'see locks', stage: ['DEV-01'], tier: 'A' }));
for (const c of table('### 1.2 Hard boundaries', '### 1.3')) {
  if (!/^B\d+$/.test(c[0])) continue;
  push({ id: `HB-${c[0]}`, kind: 'invariant', title: c[1].replace(/\*\*/g, '').slice(0, 300), acceptance: c[2], disposition: 'INVARIANT', dispositionNote: 'R8 §1.2', aStatus: 'see locks', stage: ['DEV-01'], tier: 'A' });
}
// EP action rows (method/path from A src/octo/api.ts or B src/api-fetch.ts)
const G = '/v1/bot/groups/{group_no}';
const ACTIONS = {
  'EP-01': [['register', 'POST', '/v1/bot/register'], ['register.force_refresh', 'POST', '/v1/bot/register?force_refresh=true']],
  'EP-02': [['heartbeat', 'POST', '/v1/bot/heartbeat']], 'EP-03': [['send', 'POST', '/v1/bot/sendMessage']],
  'EP-04': [['image', 'POST', '/v1/bot/sendMessage'], ['file', 'POST', '/v1/bot/sendMessage']], 'EP-05': [['richtext', 'POST', '/v1/bot/sendMessage']],
  'EP-06': [['card', 'POST', '/v1/bot/sendMessage']], 'EP-07': [['edit', 'POST', '/v1/bot/message/edit']], 'EP-08': [['profile', 'GET', '/v1/bot/card/profile']],
  'EP-09': [['typing', 'POST', '/v1/bot/typing']], 'EP-10': [['readReceipt', 'POST', '/v1/bot/readReceipt']], 'EP-11': [['sync', 'POST', '/v1/bot/messages/sync']],
  'EP-12': [['list', 'GET', '/v1/bot/groups'], ['get', 'GET', G]], 'EP-13': [['get', 'GET', `${G}/members`]], 'EP-14': [['get', 'GET', `${G}/mention_pref`]],
  'EP-15': [['GET', 'GET', `${G}/md`], ['PUT', 'PUT', `${G}/md`]], 'EP-16': [['GET', 'GET', `${G}/threads/{short_id}/md`], ['PUT', 'PUT', `${G}/threads/{short_id}/md`]],
  'EP-17': [['info', 'PUT', `${G}/info`], ['create', 'POST', '/v1/bot/createGroup'], ['members.add', 'POST', `${G}/members/add`], ['members.remove', 'POST', `${G}/members/remove`]],
  'EP-18': [['create', 'POST', `${G}/threads`], ['list', 'GET', `${G}/threads`], ['get', 'GET', `${G}/threads/{short_id}`], ['delete', 'DELETE', `${G}/threads/{short_id}`], ['members', 'GET', `${G}/threads/{short_id}/members`], ['join', 'POST', `${G}/threads/{short_id}/join`], ['leave', 'POST', `${G}/threads/{short_id}/leave`]],
  'EP-19': [['get', 'GET', '/v1/bot/user/info?uid={uid}']], 'EP-20': [['space-members', 'GET', '/v1/bot/space/members'], ['resolve-targets', 'POST', '/v1/bot/resolve/targets']],
  'EP-21': [['get', 'GET', '/v1/bot/upload/credentials?filename={name}']], 'EP-22': [['presigned', 'POST', '/v1/bot/upload/presigned'], ['put', 'PUT', '/{presigned-object-path} (host from the presigned response)']],
  'EP-23': [['GET', 'GET', '/v1/bot/voice/context'], ['PUT', 'PUT', '/v1/bot/voice/context'], ['DELETE', 'DELETE', '/v1/bot/voice/context']],
  'EP-24': [['get', 'GET', '/v1/bot/obo-grant']], 'EP-25': [['resolve', 'POST', '/v1/bot/secrets/resolve']],
  'EP-26': [['events', 'GET', '/v1/bot/events'], ['ack', 'POST', '/v1/bot/events/{event_id}/ack']],
  'EP-27': [['comments', 'POST', '/v1/bot/docs/{doc_id}/comments'], ['comment-task', 'GET', '/v1/bot/docs/{doc_id}/comment-task'], ['ppt', 'POST', '/v1/bot/docs/{doc_id}/ppt'], ['replies', 'POST', '/v1/bot/docs/{doc_id}/comments/{comment_id}/replies']],
  'EP-28': [['md-event', 'WS', 'ws:RECV payload.event group_md_updated|thread_md_updated|*_deleted'], ['pref-event', 'WS', 'ws:RECV payload.event mention_pref_updated']],
};
const ACTION_REFS = {
  'EP-01.register': [T.FO01, T.FO07], 'EP-01.register.force_refresh': [T.FO05, T.T11], 'EP-02.heartbeat': [T.EP02], 'EP-03.send': [T.EP03],
  'EP-09.typing': [T.EP02], 'EP-10.readReceipt': [T.EP02], 'EP-11.sync': [T.EP11, T.R5], 'EP-13.get': [T.EP13, T.EP14], 'EP-14.get': [T.EP14, T.EP28],
  'EP-15.GET': [T.EP14], 'EP-16.GET': [T.EP14, T.mdApi], 'EP-19.get': [T.EP19], 'EP-21.get': [T.EP21], 'EP-28.md-event': [T.EP28, T.T23], 'EP-28.pref-event': [T.EP28, T.BX8],
};
for (const [ep, acts] of Object.entries(ACTIONS)) {
  const parent = rows.find((r) => r.id === ep);
  for (const [name, method, path] of acts) {
    const id = `${ep}.${name}`;
    REFS[id] = ACTION_REFS[id] ?? [];
    const implemented = (ACTION_REFS[id] ?? []).length > 0;
    push({ id, kind: 'endpoint-action', method, path, title: `${parent.title} — ${name}`, acceptance: `request/response/error wire fixture for ${method} ${path}`,
      disposition: /^(EP-15|EP-16)\.PUT$/.test(id) ? 'TIER-OD' : implemented && parent.disposition !== 'REUSE' ? 'ADAPT' : parent.disposition, dispositionNote: parent.dispositionNote, aStatus: implemented ? 'A implements' : 'missing in A',
      stage: /^(EP-15|EP-16)\.GET$/.test(id) ? ['—'] : parent.stage, tier: /^(EP-15|EP-16)\.PUT$/.test(id) ? 'B' : parent.tier });
  }
}
// management + message actions (source: B golden)
for (const a of mgmt.actions) push({ id: `O24.mgmt.${a}`, kind: 'management-action', title: `octo_management action ${a}`, acceptance: 'action-level request/response/error fixture with TurnContext principal authorization', disposition: a === 'write-secret' ? 'TIER-OD' : 'TIER-OD', dispositionNote: a === 'write-secret' ? 'TIER-OD (Tier C, DEV-17)' : 'TIER-OD → REWRITE as dynamic tools (DEV-14)', aStatus: 'missing in A', stage: [a === 'write-secret' ? 'DEV-17' : a.startsWith('voice-context') ? 'DEV-17' : 'DEV-14'], tier: a === 'write-secret' || a.startsWith('voice-context') ? 'C' : 'B' });
for (const a of mgmt.messageActions) push({ id: `O24.msg.${a}`, kind: 'message-action', title: `message tool action ${a} (separate from octo_management)`, acceptance: 'action-level fixture; requester-scoped authorization', disposition: 'TIER-OD', dispositionNote: 'TIER-OD → REWRITE as dynamic tools (DEV-14)', aStatus: 'missing in A', stage: ['DEV-14'], tier: 'B' });

const matrix = {
  schemaVersion: 1, revision: 'R8', currentStage: 'DEV-01',
  sources: { r8: 'R8 §§1.2, 4.1–4.8, 5.1–5.8, 7.1', managementActions: 'test/goldens/b/management-actions.json (pinned B source)' },
  blockers: [{
    id: 'R8-MGMT-27', status: 'open',
    detail: `R8 §4 O24 / §9 DEV-14 state 27 octo_management actions. Pinned B src/agent-tools.ts (sha256 ${mgmt.source.sha256}) defines ${mgmt.actions.length} management actions; send/read/search are separate message-tool actions (src/channel.ts). The matrix records the source-backed ${mgmt.actions.length} + ${mgmt.messageActions.length}; PM-05 stays failing until a source-backed R8 amendment.`,
  }],
  fields: ['id', 'kind', 'title', 'acceptance', 'disposition', 'owner', 'stage', 'tests', 'layer', 'fixture', 'evidence', 'executionStatus', 'implementationStatus', 'gap'],
  rows,
};
writeFileSync('test/parity-matrix.json', JSON.stringify(matrix, null, 2) + '\n');
mkdirSync('test/contracts', { recursive: true });
for (const [file, { describe, titles }] of contracts) {
  const body = `/**\n * Named pending contracts for ${describe.replace(' pending contracts', '')} (R8 §4/§5 parity matrix).\n * Each it.todo is a placeholder the owning stage replaces with an executable\n * test; todo cases are reported pending and can never back a passed row.\n */\nimport { describe, it } from 'vitest';\n\ndescribe('${describe}', () => {\n${titles.map((t) => `  it.todo('${t.replace(/\\/g, '\\\\')}');`).join('\n')}\n});\n`;
  writeFileSync(file, body);
}
console.log(`rows=${rows.length} contracts=${[...contracts.values()].reduce((n, c) => n + c.titles.length, 0)} files=${contracts.size}`);
