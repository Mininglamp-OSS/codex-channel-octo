import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { evaluateDelivery } from './oracle.mjs';

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
