import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { evaluateDelivery, sha256 } from './oracle.mjs';

const fixtures = (id: string) => JSON.parse(readFileSync(new URL(`./fixtures/${id}.json`, import.meta.url), 'utf8'));
const ledgers = JSON.parse(readFileSync(new URL('./capture-ledgers-v1.json', import.meta.url), 'utf8')).fixtures;
const clone = <T,>(v: T): T => structuredClone(v);
const evaluate = evaluateDelivery as (trace: any, ledger?: any) => { verdict: string; violations: Array<{ code: string }> };
const codes = (r: ReturnType<typeof evaluate>) => r.violations.map(v => v.code);

describe('B-3 independent capture completeness', () => {
  it('B3-01: complete independent capture inventory keeps the original positive control green', () => {
    expect(evaluate(fixtures('ORACLE-07').controlTrace, ledgers['ORACLE-07'].controlTrace).verdict).toBe('pass');
    expect(evaluate(fixtures('ORACLE-07').trace, ledgers['ORACLE-07'].trace).verdict).toBe('fail');
  });
  it('B3-02: no capture inventory can never prove completeness even if message inventory is complete', () => {
    const r = evaluate(fixtures('ORACLE-07').controlTrace);
    expect(r.verdict).toBe('pending');
    expect(codes(r)).toContain('incomplete-capture-inventory');
  });
  it.each(['all', 'retry'])('B3-03: dropping %s captures cannot hide duplicate delivery attempts', mode => {
    const trace = clone(fixtures('ORACLE-07').trace);
    trace.captures = mode === 'all' ? [] : trace.captures.slice(0, 1);
    const r = evaluate(trace, ledgers['ORACLE-07'].trace);
    expect(r.verdict).not.toBe('pass');
    expect(codes(r)).toContain('incomplete-capture-inventory');
  });
  const mutations: Array<[string, (ledger: any) => void]> = [
    ['unsealed window', l => { l.sealed = false; }],
    ['host-owned count', l => { l.source = 'host'; }],
    ['wrong fixture scope', l => { l.fixture = 'other-fixture'; }],
    ['count gap', l => { l.declaredAttemptCount++; }],
    ['page count gap', l => { l.declaredPageCount++; }],
    ['missing cursor head', l => { l.firstCursor = 'missing'; }],
    ['broken cursor chain', l => { l.pages[0].next = 'lost-page'; }],
    ['overlapping page', l => { l.pages.push(clone(l.pages[0])); l.declaredPageCount++; }],
    ['missing retry ordinal', l => { l.pages[0].requestOrdinals.pop(); }],
    ['duplicate ordinal', l => { l.pages[0].requestOrdinals[1] = l.pages[0].requestOrdinals[0]; }],
    ['wrong run window', l => { l.windows[0].run = 'other-run'; }],
    ['wrong incarnation window', l => { l.windows[0].incarnation = 'other-incarnation'; }],
    ['window count gap', l => { l.windows[0].attemptCount++; }],
    ['unsupported version', l => { l.version = 'unknown'; }],
  ];
  it.each(mutations)('B3-04: %s remains incomplete', (_name, mutate) => {
    const ledger = clone(ledgers['ORACLE-07'].controlTrace);
    // Use the two-attempt trace to exercise duplicate/gap checks too.
    Object.assign(ledger, clone(ledgers['ORACLE-07'].trace));
    mutate(ledger);
    const trace = clone(fixtures('ORACLE-07').trace);
    // Keep the legitimate duplicate failure; incomplete evidence cannot erase it.
    const r = evaluate(trace, ledger);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('incomplete-capture-inventory');
    expect(codes(r)).toContain('duplicate-logical-attempt');
  });
  it('B3-05: inventory-complete stored delivery without a capture still fails reconciliation', () => {
    const trace = clone(fixtures('ORACLE-07').controlTrace);
    trace.captures = [];
    const ledger = { ...clone(ledgers['ORACLE-07'].controlTrace), declaredAttemptCount: 0, declaredPageCount: 0, firstCursor: null, pages: [], windows: [] };
    const r = evaluate(trace, ledger);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('uncaptured-delivery');
  });
  it.each(['target', 'sender', 'body', 'count', 'response-id'])('B3-06: captured %s must reconcile to the committed delivery', field => {
    const trace = clone(fixtures('ORACLE-07').controlTrace);
    if (field === 'target') trace.captures[0].target.channelId = 'other-target';
    if (field === 'sender') trace.captures[0].senderUid = 'other-sender';
    if (field === 'body') trace.captures[0].requestBodyHash = '0'.repeat(64);
    if (field === 'count') trace.captures[0].count++;
    if (field === 'response-id') trace.captures[0].responseMessageId = 'other-message';
    expect(evaluate(trace, ledgers['ORACLE-07'].controlTrace).verdict).toBe('fail');
  });
  it('B3-07: a permitted retry and an ambiguous result retain their distinct outcomes with complete captures', () => {
    expect(evaluate(fixtures('ORACLE-06').trace, ledgers['ORACLE-06'].trace).verdict).toBe('pass');
    expect(evaluate(fixtures('ORACLE-04').trace, ledgers['ORACLE-04'].trace).verdict).toBe('unknown');
  });
  it('B3-08: independently sealed zero-attempt suppressed scenario may pass; host receipts cannot replace a missing ledger', () => {
    const trace = clone(fixtures('ORACLE-07').controlTrace);
    trace.expected[0].outcome = 'suppressed'; trace.captures = []; trace.inventory.pages[0].records = [];
    const ledger = { ...clone(ledgers['ORACLE-07'].controlTrace), declaredAttemptCount: 0, declaredPageCount: 0, firstCursor: null, pages: [], windows: [] };
    expect(evaluate(trace, ledger).verdict).toBe('pass');
    trace.hostReceipts = [{ attemptCount: 0, complete: true }];
    expect(evaluate(trace).verdict).toBe('pending');
  });
});

describe('B-3 review repair: identity, explaining outcome and retry authorization', () => {
  const pristine = (id: string, key: string) => clone(ledgers[id][key]);
  const evaluateSealed = (id: string, key: string, trace: any) => {
    const ledger = pristine(id, key);
    const r = evaluate(trace, ledger);
    // The independent ledger is never derived from or rewritten by the altered captures.
    expect(ledger).toEqual(ledgers[id][key]);
    return r;
  };
  const ORIGINAL_MARKER = '[DLY f=fx07 o=oc7 r=run7 k=cron.alert m=000001 s=000001/000001]';
  const HASH_06 = 'eb8688b110faa6757c3ef4db228843160de15c365d8e88aaa3986c2cbd8fcf52';

  it('B3-09: a stored marker with a changed segment count cannot reconcile to the expected identity', () => {
    const trace = clone(fixtures('ORACLE-07').controlTrace);
    expect(trace.inventory.pages[0].records[0].fixtureMarker).toBe(ORIGINAL_MARKER);
    trace.inventory.pages[0].records[0].fixtureMarker = ORIGINAL_MARKER.replace('/000001]', '/999999]');
    const r = evaluateSealed('ORACLE-07', 'controlTrace', trace);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('unexpected-delivery');
  });

  it.each([
    ['count zero', 's=000001/000000]'],
    ['index zero', 's=000000/000001]'],
    ['index out of bounds', 's=000002/000001]'],
    ['larger count', 's=000001/000002]'],
  ])('B3-10: stored marker %s is not a permitted identity', (_name, suffix) => {
    const trace = clone(fixtures('ORACLE-07').controlTrace);
    trace.inventory.pages[0].records[0].fixtureMarker = ORIGINAL_MARKER.replace('s=000001/000001]', suffix);
    const r = evaluateSealed('ORACLE-07', 'controlTrace', trace);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('unexpected-delivery');
  });

  it.each([
    ['fixture', 'f=fx07', 'f=fx99'],
    ['occurrence', 'o=oc7', 'o=oc8'],
    ['run', 'r=run7', 'r=run8'],
    ['kind', 'k=cron.alert', 'k=cron.result'],
    ['ordinal', 'm=000001', 'm=000002'],
    ['width', 'm=000001', 'm=1'],
  ])('B3-10: stored marker %s variation is not a permitted identity', (_name, from, to) => {
    const trace = clone(fixtures('ORACLE-07').controlTrace);
    trace.inventory.pages[0].records[0].fixtureMarker = ORIGINAL_MARKER.replace(from, to);
    expect(evaluateSealed('ORACLE-07', 'controlTrace', trace).verdict).toBe('fail');
  });

  it.each([
    ['count zero', { count: 0 }],
    ['index zero', { index: 0 }],
    ['index out of bounds', { index: 2 }],
    ['non-integer count', { count: 1.5 }],
  ])('B3-10: captured identity with %s is malformed and cannot explain the delivery', (_name, patch) => {
    const trace = clone(fixtures('ORACLE-07').controlTrace);
    Object.assign(trace.captures[0], patch);
    const r = evaluateSealed('ORACLE-07', 'controlTrace', trace);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('incomplete-capture-inventory');
  });

  it('B3-10: the unchanged control and original fixture marker still pass', () => {
    expect(evaluateSealed('ORACLE-07', 'controlTrace', clone(fixtures('ORACLE-07').controlTrace)).verdict).toBe('pass');
    expect(fixtures('ORACLE-07').controlTrace.inventory.pages[0].records[0].fixtureMarker).toBe(ORIGINAL_MARKER);
  });

  it('B3-11: a rejected 403 response cannot explain a committed delivery', () => {
    const trace = clone(fixtures('ORACLE-07').controlTrace);
    expect(trace.captures).toHaveLength(1);
    trace.captures[0].httpStatus = 403;
    expect(trace.captures[0].transportOutcome).toBe('response');
    expect(trace.captures[0].responseMessageId).toBeNull();
    const r = evaluateSealed('ORACLE-07', 'controlTrace', trace);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('uncaptured-delivery');
  });

  it.each([
    ['400 response', { httpStatus: 400 }],
    ['404 response', { httpStatus: 404 }],
    ['409 response', { httpStatus: 409 }],
    ['429 response', { httpStatus: 429 }],
    ['302 response', { httpStatus: 302 }],
    ['101 response', { httpStatus: 101 }],
    ['pre-write failure', { httpStatus: null, transportOutcome: 'prewrite-failure' }],
  ])('B3-11: %s cannot explain a committed delivery', (_name, patch) => {
    const trace = clone(fixtures('ORACLE-07').controlTrace);
    Object.assign(trace.captures[0], patch);
    const r = evaluateSealed('ORACLE-07', 'controlTrace', trace);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('uncaptured-delivery');
  });

  it.each([
    ['unknown transport outcome', { httpStatus: null, transportOutcome: 'rejected' }],
    ['response without status', { httpStatus: null }],
    ['timeout with status', { httpStatus: 200, transportOutcome: 'timeout' }],
    ['string status', { httpStatus: '200' }],
    ['timeout with response id', { httpStatus: null, transportOutcome: 'timeout', responseMessageId: '900000000000000019' }],
  ])('B3-11: malformed outcome (%s) cannot explain a committed delivery', (_name, patch) => {
    const trace = clone(fixtures('ORACLE-07').controlTrace);
    Object.assign(trace.captures[0], patch);
    const r = evaluateSealed('ORACLE-07', 'controlTrace', trace);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('uncaptured-delivery');
    expect(codes(r)).toContain('incomplete-capture-inventory');
  });

  it.each([
    ['unchanged 200 success', {}],
    ['201 success', { httpStatus: 201 }],
    ['success with matching response id', { responseMessageId: '900000000000000019' }],
    ['timeout ambiguity', { httpStatus: null, transportOutcome: 'timeout' }],
    ['disconnect ambiguity', { httpStatus: null, transportOutcome: 'disconnect' }],
    ['reset ambiguity', { httpStatus: null, transportOutcome: 'reset' }],
    ['503 ambiguity', { httpStatus: 503 }],
    ['503 ambiguity with matching response id', { httpStatus: 503, responseMessageId: '900000000000000019' }],
  ])('B3-11: %s can explain a committed delivery', (_name, patch) => {
    const trace = clone(fixtures('ORACLE-07').controlTrace);
    Object.assign(trace.captures[0], patch);
    expect(evaluateSealed('ORACLE-07', 'controlTrace', trace).verdict).toBe('pass');
  });

  it.each([
    ['success', {}],
    ['503 ambiguity', { httpStatus: 503 }],
  ])('B3-11: %s with a different response id cannot explain the delivery', (_name, patch) => {
    const trace = clone(fixtures('ORACLE-07').controlTrace);
    Object.assign(trace.captures[0], patch, { responseMessageId: '900000000000000099' });
    const r = evaluateSealed('ORACLE-07', 'controlTrace', trace);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('uncaptured-delivery');
  });

  it('B3-11: ambiguity on an unknown segment keeps its documented unknown verdict', () => {
    const f = fixtures('ORACLE-04');
    expect(evaluate(f.trace, ledgers['ORACLE-04'].trace).verdict).toBe('unknown');
    const once = f.variants.find((v: { name: string }) => v.name === 'observed-once');
    expect(evaluate(once.trace, ledgers['ORACLE-04']['observed-once']).verdict).toBe('unknown');
    expect(evaluate(fixtures('ORACLE-05').trace, ledgers['ORACLE-05'].trace).verdict).toBe('fail');
  });

  it('B3-12: removing both retry keys cannot authorize the ORACLE-06 retry', () => {
    const changed = clone(fixtures('ORACLE-06').trace);
    changed.captures[1].clientMsgNo = 'cmn-run6-2';
    const changedResult = evaluateSealed('ORACLE-06', 'trace', changed);
    expect(changedResult.verdict).toBe('fail');
    expect(codes(changedResult)).toContain('changed-retry-payload');

    const deleted = clone(fixtures('ORACLE-06').trace);
    for (const c of deleted.captures) delete c.clientMsgNo;
    const r = evaluateSealed('ORACLE-06', 'trace', deleted);
    expect(r.verdict).not.toBe('pass');
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('unverifiable-retry');
    expect(codes(r)).toContain('incomplete-capture-inventory');
  });

  const retryDefects: Array<[string, (c: any, i: number) => void]> = [
    ['null retry key', c => { c.clientMsgNo = null; }],
    ['empty retry key', c => { c.clientMsgNo = ''; }],
    ['numeric retry key', c => { c.clientMsgNo = 6; }],
    ['missing body hash', c => { delete c.requestBodyHash; c.serverNormalizedPayloadHash = HASH_06; }],
    ['empty body hash', c => { c.requestBodyHash = ''; c.serverNormalizedPayloadHash = HASH_06; }],
    ['malformed body hash', c => { c.requestBodyHash = 'not-a-hash'; c.serverNormalizedPayloadHash = HASH_06; }],
    ['uppercase body hash', c => { c.requestBodyHash = HASH_06.toUpperCase(); c.serverNormalizedPayloadHash = HASH_06; }],
    ['malformed normalized hash', c => { c.serverNormalizedPayloadHash = 'zz'; }],
    ['missing incarnation', c => { delete c.incarnation; }],
    ['empty incarnation', c => { c.incarnation = ''; }],
    ['numeric incarnation', c => { c.incarnation = 1; }],
    ['missing first transport outcome', (c, i) => { if (i === 0) delete c.transportOutcome; }],
    ['429 status on a timeout', (c, i) => { if (i === 0) c.transportOutcome = 'timeout'; }],
    ['string 429 status', (c, i) => { if (i === 0) c.httpStatus = '429'; }],
    ['non-integer status', (c, i) => { if (i === 0) c.httpStatus = 429.5; }],
  ];
  it.each(retryDefects)('B3-13: %s never permits a retry', (_name, mutate) => {
    const trace = clone(fixtures('ORACLE-06').trace);
    trace.captures.forEach((c: any, i: number) => mutate(c, i));
    const r = evaluateSealed('ORACLE-06', 'trace', trace);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('incomplete-capture-inventory');
  });

  it.each([
    ['unchanged 429 retry', () => {}],
    ['matching normalized hashes', (c: any) => { c.serverNormalizedPayloadHash = HASH_06; }],
    ['pre-write failure retry', (c: any, i: number) => { if (i === 0) { c.httpStatus = null; c.transportOutcome = 'prewrite-failure'; } }],
  ])('B3-13: valid retry control (%s) still passes', (_name, mutate: (c: any, i: number) => void) => {
    const trace = clone(fixtures('ORACLE-06').trace);
    trace.captures.forEach((c: any, i: number) => mutate(c, i));
    const r = evaluateSealed('ORACLE-06', 'trace', trace) as ReturnType<typeof evaluate> & { counts: Record<string, number> };
    expect(r.verdict).toBe('pass');
    expect(r.counts.permittedNetworkRetries).toBe(1);
  });

  it('B3-14: every original fixture trace, control and variant still reconciles to its sealed ledger', () => {
    for (const id of Object.keys(ledgers)) {
      const f = fixtures(id);
      const traces: Array<[string, any]> = [['trace', f.trace], ['controlTrace', f.controlTrace],
        ...(f.variants ?? []).map((v: { name: string; trace: any }) => [v.name, v.trace] as [string, any])];
      for (const [key, trace] of traces) {
        if (!trace) continue;
        const r = evaluate(trace, ledgers[id][key]) as ReturnType<typeof evaluate> & { captureCompleteness: { complete: boolean; reasons: string[] } };
        expect(r.captureCompleteness, `${id}/${key}`).toEqual(expect.objectContaining({ complete: true, reasons: [] }));
      }
    }
  });
});

describe('B-3 deep repair: injective identity encoding and full-field reconciliation', () => {
  type Identity = { occurrence: string; run: string; kind: string };
  // Independently declared synthetic seals, one per delimiter-bearing run. They are
  // written here, never derived from the (possibly mutated) captures under test.
  const SEALS: Record<string, object> = {
    run1: {
      version: 'capture-inventory-v1', source: 'independent-tester-synthetic', fixture: 'fx07', sealed: true,
      declaredAttemptCount: 1, declaredPageCount: 1, firstCursor: 'fx07:delimiter-run1:0',
      windows: [{ run: 'run1', incarnation: 'inc-1', firstOrdinal: 16, lastOrdinal: 16, attemptCount: 1 }],
      pages: [{ cursor: 'fx07:delimiter-run1:0', next: null, requestOrdinals: [16] }],
    },
    'run1|cron': {
      version: 'capture-inventory-v1', source: 'independent-tester-synthetic', fixture: 'fx07', sealed: true,
      declaredAttemptCount: 1, declaredPageCount: 1, firstCursor: 'fx07:delimiter-run1-cron:0',
      windows: [{ run: 'run1|cron', incarnation: 'inc-1', firstOrdinal: 16, lastOrdinal: 16, attemptCount: 1 }],
      pages: [{ cursor: 'fx07:delimiter-run1-cron:0', next: null, requestOrdinals: [16] }],
    },
    'run","1': {
      version: 'capture-inventory-v1', source: 'independent-tester-synthetic', fixture: 'fx07', sealed: true,
      declaredAttemptCount: 1, declaredPageCount: 1, firstCursor: 'fx07:delimiter-json:0',
      windows: [{ run: 'run","1', incarnation: 'inc-1', firstOrdinal: 16, lastOrdinal: 16, attemptCount: 1 }],
      pages: [{ cursor: 'fx07:delimiter-json:0', next: null, requestOrdinals: [16] }],
    },
  };
  const OCC_RUN: Identity = { occurrence: 'oc|extra', run: 'run1', kind: 'cron.alert' };
  const RUN_KIND: Identity = { occurrence: 'oc', run: 'run1|cron', kind: 'alert' };
  const JSON_CHARS: Identity = { occurrence: 'oc|x', run: 'run","1', kind: 'cron[1]\\alert' };
  const markerOf = (i: Identity, fixture = 'fx07') => `[DLY f=${fixture} o=${i.occurrence} r=${i.run} k=${i.kind} m=000001 s=000001/000001]`;
  // A genuine valid trace cloned from the ORACLE-07 control with a delimiter-bearing identity.
  const control = (i: Identity) => {
    const trace = clone(fixtures('ORACLE-07').controlTrace);
    const body = `${markerOf(i)}\nalert`;
    Object.assign(trace.expected[0].identity, i);
    trace.expected[0].body = body;
    Object.assign(trace.captures[0], i, {
      logicalIdentity: `${i.occurrence}/${i.run}/${i.kind}/1/1`, requestBodyHash: sha256(body), clientMsgNo: `cmn-${i.run}-1`,
    });
    Object.assign(trace.inventory.pages[0].records[0], { fixtureMarker: markerOf(i), payloadHash: sha256(body) });
    return trace;
  };
  const evaluateSealed = (id: string, key: string, trace: any) => {
    const ledger = clone(ledgers[id][key]);
    const r = evaluate(trace, ledger);
    expect(ledger).toEqual(ledgers[id][key]);
    return r;
  };
  const sealed = (run: string, trace: any) => {
    const seal = clone(SEALS[run]);
    const r = evaluate(trace, seal) as ReturnType<typeof evaluate> & { captureCompleteness: { complete: boolean; reasons: string[] } };
    expect(seal).toEqual(SEALS[run]);
    return r;
  };

  it.each([
    ['occurrence/run', OCC_RUN],
    ['run/kind', RUN_KIND],
    ['JSON metacharacters', JSON_CHARS],
  ])('B3-15: a valid %s delimiter-bearing identity is a genuine positive control', (_name, identity) => {
    const trace = control(identity);
    expect(trace.inventory.pages[0].records[0].payloadHash).toBe(sha256(trace.expected[0].body));
    expect(trace.captures[0].requestBodyHash).toBe(sha256(trace.expected[0].body));
    const r = sealed(identity.run, trace);
    expect(r.violations).toEqual([]);
    expect(r.verdict).toBe('pass');
    expect(r.captureCompleteness).toEqual(expect.objectContaining({ complete: true, reasons: [] }));
  });

  it('B3-16: shifting the delimiter across the stored occurrence/run boundary is an unexpected delivery', () => {
    const trace = control(OCC_RUN);
    const before = clone(trace);
    trace.inventory.pages[0].records[0].fixtureMarker = '[DLY f=fx07 o=oc r=extra|run1 k=cron.alert m=000001 s=000001/000001]';
    // Only the stored marker changed: expected, capture, hashes and seal are untouched.
    expect({ ...trace, inventory: before.inventory }).toEqual(before);
    const r = sealed('run1', trace);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('unexpected-delivery');
  });

  it.each([
    ['run/kind', RUN_KIND, '[DLY f=fx07 o=oc r=run1 k=cron|alert m=000001 s=000001/000001]'],
    ['occurrence/run (reverse)', RUN_KIND, '[DLY f=fx07 o=oc|run1 r=cron k=alert m=000001 s=000001/000001]'],
    ['fixture/occurrence', OCC_RUN, '[DLY f=fx07|oc o=extra r=run1 k=cron.alert m=000001 s=000001/000001]'],
    ['JSON metacharacters', JSON_CHARS, '[DLY f=fx07 o=oc r=x|run","1 k=cron[1]\\alert m=000001 s=000001/000001]'],
  ])('B3-16: a stored %s delimiter shift is an unexpected delivery', (_name, identity, marker) => {
    const trace = control(identity);
    trace.inventory.pages[0].records[0].fixtureMarker = marker;
    const r = sealed(identity.run, trace);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('unexpected-delivery');
  });

  it.each([
    ['ordinal', '[DLY f=fx07 o=oc|extra r=run1 k=cron.alert m=000001|1 s=000001/000001]'],
    ['index', '[DLY f=fx07 o=oc|extra r=run1 k=cron.alert m=000001 s=000001|1/000001]'],
    ['kind/ordinal', '[DLY f=fx07 o=oc|extra r=run1 k=cron.alert|000001 s=000001/000001]'],
    ['empty occurrence', '[DLY f=fx07 o= r=extra|run1 k=cron.alert m=000001 s=000001/000001]'],
  ])('B3-16: a stored %s delimiter shift is grammar-invalid and cannot reconcile', (_name, marker) => {
    const trace = control(OCC_RUN);
    trace.inventory.pages[0].records[0].fixtureMarker = marker;
    const r = sealed('run1', trace);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('unexpected-delivery');
  });

  it.each([
    ['occurrence/run', OCC_RUN, { occurrence: 'oc', run: 'extra|run1' }],
    ['run/kind', RUN_KIND, { run: 'run1', kind: 'cron|alert' }],
    ['fixture/occurrence', OCC_RUN, { fixture: 'fx07|oc', occurrence: 'extra' }],
  ])('B3-17: a captured %s delimiter shift cannot explain the delivery', (_name, identity, patch) => {
    const trace = control(identity);
    Object.assign(trace.captures[0], patch);
    const r = sealed(identity.run, trace);
    expect(r.verdict).not.toBe('pass');
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('unexpected-attempt');
    expect(codes(r)).toContain('uncaptured-delivery');
  });

  it('B3-17: a stored and captured collision together cannot satisfy a delimiter-bearing expectation', () => {
    const trace = control(OCC_RUN);
    trace.inventory.pages[0].records[0].fixtureMarker = '[DLY f=fx07 o=oc r=extra|run1 k=cron.alert m=000001 s=000001/000001]';
    Object.assign(trace.captures[0], { occurrence: 'oc', run: 'extra|run1' });
    const r = sealed('run1', trace);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toEqual(expect.arrayContaining(['unexpected-delivery', 'unexpected-attempt', 'missing-confirmed-segment']));
  });

  it.each([
    ['string ordinal', { ordinal: '1' }],
    ['string index', { index: '1' }],
    ['delimiter ordinal', { ordinal: '1|1' }],
    ['delimiter index', { index: '1|1' }],
    ['delimiter kind with ordinal', { kind: 'cron.alert|1' }],
    ['empty occurrence', { occurrence: '' }],
    ['empty run', { run: '' }],
    ['missing kind', { kind: undefined }],
    ['changed count', { count: 2 }],
    ['string count', { count: '1' }],
  ])('B3-18: a captured identity with %s cannot pass', (_name, patch) => {
    const trace = control(OCC_RUN);
    Object.assign(trace.captures[0], patch);
    const r = sealed('run1', trace);
    expect(r.verdict).toBe('fail');
  });

  it.each([
    ['string ordinal', { ordinal: '1' }],
    ['string index', { index: '1' }],
    ['string count', { count: '1' }],
    ['empty occurrence', { occurrence: '' }],
    ['missing run', { run: undefined }],
    ['zero index', { index: 0 }],
  ])('B3-18: an expected identity with %s cannot pass', (_name, patch) => {
    const trace = control(OCC_RUN);
    Object.assign(trace.expected[0].identity, patch);
    const r = sealed('run1', trace);
    expect(r.verdict).toBe('fail');
  });

  it('B3-18: a changed stored segment count on a delimiter-bearing identity cannot reconcile', () => {
    const trace = control(OCC_RUN);
    trace.inventory.pages[0].records[0].fixtureMarker = markerOf(OCC_RUN).replace('/000001]', '/000002]');
    const r = sealed('run1', trace);
    expect(r.verdict).toBe('fail');
    expect(codes(r)).toContain('unexpected-delivery');
  });

  it('B3-19: the original sealed ledgers are not inferred from or rewritten by delimiter mutations', () => {
    const trace = control(OCC_RUN);
    Object.assign(trace.captures[0], { occurrence: 'oc', run: 'extra|run1' });
    // The original ORACLE-07 seal declares run7 and cannot be borrowed for run1.
    const r = evaluateSealed('ORACLE-07', 'controlTrace', trace) as ReturnType<typeof evaluate> & { captureCompleteness: { complete: boolean } };
    expect(r.verdict).toBe('fail');
    expect(r.captureCompleteness.complete).toBe(false);
    expect(evaluateSealed('ORACLE-07', 'controlTrace', clone(fixtures('ORACLE-07').controlTrace)).verdict).toBe('pass');
  });
});
