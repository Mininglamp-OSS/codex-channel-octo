// One-off author tool for the frozen ORACLE-01..08 traces (R8 §10.10).
// Run from the repo root: node scripts/dev01/build-oracle-fixtures.mjs
// The committed JSON files are the frozen inputs; this script only documents
// how they were authored. It does not call the oracle.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const p6 = (n) => String(n).padStart(6, '0');
const marker = (o) => `[DLY f=${o.fixture} o=${o.occurrence} r=${o.run} k=${o.kind} m=${p6(o.ordinal)} s=${p6(o.index)}/${p6(o.count)}]`;
const T = { channelId: 'g_oracle', channelType: 2 };
const BOT = 'u_bot_oracle';
const clone = (x) => JSON.parse(JSON.stringify(x));

function seg(fixture, occurrence, run, kind, ordinal, index, count, text, outcome = 'confirmed') {
  const identity = { occurrence, run, kind, ordinal, index, count };
  const body = `${marker({ fixture, ...identity })}\n${text}`;
  return { identity, target: T, senderUid: BOT, body, outcome };
}
let msgId = 900000000000000000n;
const stored = (fixture, e, over = {}) => ({
  messageId: String(++msgId), channelId: e.target.channelId, channelType: e.target.channelType, senderUid: e.senderUid,
  serverTimestamp: 1791900000, fixtureMarker: e.body.split('\n')[0], payloadHash: sha(e.body),
  serverNormalizedPayloadHash: null, normalizationFixtureVersion: null, ...over,
});
let ord = 0;
const capture = (fixture, e, over = {}) => ({
  fixture, logicalIdentity: `${e.identity.occurrence}/${e.identity.run}/${e.identity.kind}/${e.identity.ordinal}/${e.identity.index}`,
  kind: e.identity.kind, occurrence: e.identity.occurrence, run: e.identity.run, ordinal: e.identity.ordinal,
  index: e.identity.index, count: e.identity.count, senderUid: e.senderUid, target: e.target, requestOrdinal: ++ord,
  requestAt: '2026-10-13T00:00:00Z', requestBodyHash: sha(e.body), serverNormalizedPayloadHash: null, normalizationFixtureVersion: null,
  clientMsgNo: `cmn-${e.identity.run}-${e.identity.index}`, httpStatus: 200, responseMessageId: null, responseAt: '2026-10-13T00:00:01Z',
  transportOutcome: 'response', incarnation: 'inc-1', ...over,
});
const inventory = (records, over = {}) => ({ complete: true, declaredPageCount: 1, pages: [{ cursor: 'c0', next: null, records }], ...over });
const trace = (fixture, expected, captures, inv) => ({ fixture, expected, captures, inventory: inv });

const fixtures = {};
{ // 01: correct 3-segment send, marker on every part
  const f = 'fx01'; const es = [1, 2, 3].map((i) => seg(f, 'oc1', 'run1', 'cron.result', 0, i, 3, `part ${i}`));
  fixtures['ORACLE-01'] = { description: 'correct 3-segment send with a marker on every part', expectedVerdict: 'pass', expectedViolations: [],
    trace: trace(f, es, es.map((e) => capture(f, e)), inventory(es.map((e) => stored(f, e)))) };
}
{ // 02: duplicated middle segment
  const f = 'fx02'; const es = [1, 2, 3].map((i) => seg(f, 'oc2', 'run2', 'cron.result', 0, i, 3, `part ${i}`));
  const control = trace(f, es, es.map((e) => capture(f, e)), inventory(es.map((e) => stored(f, e))));
  const t = clone(control); t.inventory.pages[0].records.splice(2, 0, stored(f, es[1]));
  fixtures['ORACLE-02'] = { description: 'duplicated middle segment is a duplicate committed identity', expectedVerdict: 'fail', expectedViolations: ['duplicate-committed'], expectedCounts: { duplicateCommittedIdentities: 1 }, trace: t, controlTrace: control };
}
{ // 03: wrong target
  const f = 'fx03'; const es = [1, 2].map((i) => seg(f, 'oc3', 'run3', 'cron.reminder', 0, i, 2, `reminder ${i}`));
  const control = trace(f, es, es.map((e) => capture(f, e)), inventory(es.map((e) => stored(f, e))));
  const t = clone(control); t.inventory.pages[0].records[1].channelId = 'g_other';
  fixtures['ORACLE-03'] = { description: 'a segment stored in the wrong target fails (and leaves the expected segment missing)', expectedVerdict: 'fail', expectedViolations: ['wrong-target', 'missing-confirmed-segment'], trace: t, controlTrace: control };
}
{ // 04: unknown final segment with 0/1 observation
  const f = 'fx04'; const es = [seg(f, 'oc4', 'run4', 'cron.result', 0, 1, 2, 'first'), seg(f, 'oc4', 'run4', 'cron.result', 0, 2, 2, 'final', 'unknown')];
  const caps = [capture(f, es[0]), capture(f, es[1], { httpStatus: null, transportOutcome: 'timeout', responseAt: null })];
  const zero = trace(f, es, caps, inventory([stored(f, es[0])]));
  const one = trace(f, es, caps, inventory([stored(f, es[0]), stored(f, es[1])]));
  const two = trace(f, es, caps, inventory([stored(f, es[0]), stored(f, es[1]), stored(f, es[1])]));
  fixtures['ORACLE-04'] = { description: 'unknown final segment observed 0 times stays unknown (never passed)', expectedVerdict: 'unknown', expectedViolations: [], expectedCounts: { unresolvedUnknowns: 1 }, trace: zero,
    variants: [{ name: 'observed-once', expectedVerdict: 'unknown', expectedViolations: [], trace: one }, { name: 'observed-twice', expectedVerdict: 'fail', expectedViolations: ['duplicate-committed'], trace: two }] };
}
{ // 05: restart resends unknown
  const f = 'fx05'; const es = [seg(f, 'oc5', 'run5', 'cron.result', 0, 1, 1, 'only', 'unknown')];
  const first = capture(f, es[0], { httpStatus: null, transportOutcome: 'disconnect', responseAt: null });
  const control = trace(f, es, [first], inventory([]));
  control.expected = clone(es); // control: same unknown, no resend → must not fail
  const t = trace(f, es, [first, capture(f, es[0], { incarnation: 'inc-2' })], inventory([stored(f, es[0])]));
  const controlConfirmed = trace(f, [{ ...es[0], outcome: 'confirmed' }], [capture(f, es[0])], inventory([stored(f, es[0])]));
  fixtures['ORACLE-05'] = { description: 'a restart that resends an unknown segment fails even though one message is stored', expectedVerdict: 'fail', expectedViolations: ['resend-after-restart'], trace: t, controlTrace: controlConfirmed };
}
{ // 06: allowed 429 retry
  const f = 'fx06'; const es = [seg(f, 'oc6', 'run6', 'chat.reply', 0, 1, 1, 'answer')];
  fixtures['ORACLE-06'] = { description: 'an allowed 429 retry observed twice but committed once passes', expectedVerdict: 'pass', expectedViolations: [], expectedCounts: { permittedNetworkRetries: 1 },
    trace: trace(f, es, [capture(f, es[0], { httpStatus: 429 }), capture(f, es[0])], inventory([stored(f, es[0])])) };
}
{ // 07: repeated identity hidden by server dedupe
  const f = 'fx07'; const es = [seg(f, 'oc7', 'run7', 'cron.alert', 1, 1, 1, 'alert')];
  const control = trace(f, es, [capture(f, es[0])], inventory([stored(f, es[0])]));
  const t = trace(f, es, [capture(f, es[0]), capture(f, es[0])], inventory([stored(f, es[0])]));
  fixtures['ORACLE-07'] = { description: 'a repeated alert identity hidden by server dedupe is an attempt violation', expectedVerdict: 'fail', expectedViolations: ['duplicate-logical-attempt'], expectedCounts: { duplicateLogicalAttempts: 1 }, trace: t, controlTrace: control };
}
{ // 08: pagination omits a page
  const f = 'fx08'; const es = [1, 2, 3].map((i) => seg(f, 'oc8', 'run8', 'cron.result', 0, i, 3, `part ${i}`));
  const caps = es.map((e) => capture(f, e));
  const pages = [{ cursor: 'c0', next: 'c1', records: [stored(f, es[0])] }, { cursor: 'c1', next: 'c2', records: [stored(f, es[1])] }, { cursor: 'c2', next: null, records: [stored(f, es[2])] }];
  const control = trace(f, es, caps, { complete: true, declaredPageCount: 3, pages });
  const t = clone(control); t.inventory.pages.splice(1, 1); // page c1 never fetched
  fixtures['ORACLE-08'] = { description: 'read-back that omits a page is pending (incomplete), not a pass', expectedVerdict: 'pending', expectedViolations: ['incomplete-inventory'], trace: t, controlTrace: control };
}
for (const [id, f] of Object.entries(fixtures)) {
  writeFileSync(`test/oracle/fixtures/${id}.json`, JSON.stringify({ id, ...f }, null, 2) + '\n');
}
writeFileSync('test/oracle/independent-delivery-v1.json', JSON.stringify({
  version: 'independent-delivery-v1',
  source: 'R8 §10.10',
  marker: '[DLY f=<fixtureNonce> o=<occurrenceToken> r=<runToken> k=<kind> m=<logicalOrdinal 6 digits> s=<index 6>/<count 6>]',
  captureRecordFields: ['fixture', 'logicalIdentity', 'kind', 'occurrence', 'run', 'ordinal', 'index', 'count', 'senderUid', 'target',
    'requestOrdinal', 'requestAt', 'requestBodyHash', 'serverNormalizedPayloadHash', 'normalizationFixtureVersion',
    'clientMsgNo', 'httpStatus', 'responseMessageId', 'responseAt', 'transportOutcome'],
  inventoryRecordFields: ['messageId', 'channelId', 'channelType', 'senderUid', 'serverTimestamp', 'fixtureMarker', 'payloadHash',
    'serverNormalizedPayloadHash', 'normalizationFixtureVersion'],
  rules: [
    '1 each expected confirmed segment has exactly one stored message matching identity/body/sender/target; 0 = missing, >1 = duplicate committed',
    '2 every observed message maps to one permitted identity; wrong target/sender/body fails',
    '3 all attempts examined: <=2 429 retries and <=1 proven pre-write retry with identical bytes/key are permitted; retry after ambiguity, duplicate logical attempts and changed retry payloads fail even if the server dedupes',
    '4 unknown segments may be observed 0 or 1 times (verdict unknown, never pass); no resend after restart',
    '5 incomplete pagination leaves the verdict pending',
  ],
  verdicts: ['pass', 'fail', 'unknown', 'pending'],
  fixtures: Object.keys(fixtures),
}, null, 2) + '\n');
console.log('wrote', Object.keys(fixtures).join(' '));
