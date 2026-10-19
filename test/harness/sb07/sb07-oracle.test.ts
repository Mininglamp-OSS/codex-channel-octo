/**
 * SB07-F1 (R8 amendment A-R8-SB07-01): TEST ONLY transcript oracle for the
 * pinned 0.142.3 uninterrupted exec-parity rejection path.
 *
 * The baseline is a raw real-binary capture (test/fixtures/app-server/0.142.3/
 * sb07-rejection.*); expectations are written here from the amendment text,
 * not derived from the oracle. Every mutant must be rejected for its specific
 * defect, and unrelated interleaving must still be accepted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkSb07RejectionPath, type Sb07Verdict } from './oracle.js';
import type { TranscriptEntry } from '../jsonl-client.js';

const FIXTURE = new URL('../../fixtures/app-server/0.142.3/sb07-rejection.transcript.jsonl', import.meta.url);
const META = JSON.parse(readFileSync(new URL('../../fixtures/app-server/0.142.3/sb07-rejection.meta.json', import.meta.url), 'utf8')) as {
  pin: string; threadId: string; turnId: string; itemId: string; incarnation: string; transcriptSha256: string;
};
const fixtureBytes = readFileSync(FIXTURE);
const baseline = fixtureBytes.toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as TranscriptEntry);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// Normative literals (A-R8-SB07-01), written out independently of the oracle.
const MESSAGE = `command execution approval is not supported in exec mode for thread \`${META.threadId}\``;
const REPLY_BYTES = `{"id":0,"error":{"code":-32000,"message":${JSON.stringify(MESSAGE)}}}`;
const OTHER_THREAD = '01a135a4-0000-7000-8000-000000000000';

const expectation = () => ({ threadId: META.threadId, incarnation: META.incarnation });
const check = (trace: TranscriptEntry[]): Sb07Verdict => checkSb07RejectionPath(trace, expectation());
type Msg = { id?: unknown; method?: string; params?: Record<string, any>; error?: { code: number; message: string }; result?: unknown };
const msg = (e: TranscriptEntry) => e.message as Msg;
const isReq = (e: TranscriptEntry) => e.dir === 'in' && msg(e).method === 'item/commandExecution/requestApproval' && msg(e).params?.threadId === META.threadId;
const isReply = (e: TranscriptEntry) => e.dir === 'out' && msg(e).method === undefined && msg(e).error !== undefined;
const isResolved = (e: TranscriptEntry) => e.dir === 'in' && msg(e).method === 'serverRequest/resolved' && msg(e).params?.threadId === META.threadId;
const isItem = (e: TranscriptEntry) => e.dir === 'in' && msg(e).method === 'item/completed' && msg(e).params?.item?.id === META.itemId;
const isTurn = (e: TranscriptEntry) => e.dir === 'in' && msg(e).method === 'turn/completed' && msg(e).params?.turn?.id === META.turnId;
const idx = (t: TranscriptEntry[], p: (e: TranscriptEntry) => boolean) => { const i = t.findIndex(p); if (i < 0) throw new Error('fixture lacks event'); return i; };
/** Re-serialize a message after editing it, as a faithful transcript writer would. */
const reraw = (e: TranscriptEntry) => { e.raw = JSON.stringify(e.message); return e; };
/** Edit the first entry matching pred in place and re-serialize it. */
const edit = (t: TranscriptEntry[], pred: (e: TranscriptEntry) => boolean, f: (m: Msg) => void) => { const i = idx(t, pred); f(msg(t[i])); reraw(t[i]); };
const mutate = (f: (t: TranscriptEntry[]) => void) => { const t = clone(baseline); f(t); return check(t); };
const insertAfter = (t: TranscriptEntry[], i: number, e: TranscriptEntry) => t.splice(i + 1, 0, e);
/** Give the request, its reply and its resolution another (consistent) id. */
const renumber = (t: TranscriptEntry[], id: number | string) => {
  const [q, r, s] = [idx(t, isReq), idx(t, isReply), idx(t, isResolved)];
  msg(t[q]).id = id; msg(t[r]).id = id; msg(t[s]).params!.requestId = id;
  for (const i of [q, r, s]) reraw(t[i]);
  t[r].raw = `{"id":${JSON.stringify(id)},"error":{"code":-32000,"message":${JSON.stringify(MESSAGE)}}}`;
};
const note = (method: string, params: Record<string, unknown>, at: number, incarnation = META.incarnation): TranscriptEntry =>
  reraw({ dir: 'in', at, message: { method, params }, incarnation });

describe('SB07-F1 oracle: baseline real capture', () => {
  it('SB07-F1-OR-00: the fixture is the recorded raw capture of the pinned binary', () => {
    expect(META.pin).toBe('0.142.3');
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(META.transcriptSha256);
    const reply = baseline.find(isReply)!;
    expect(reply.raw).toBe(REPLY_BYTES);
    expect(reply.incarnation).toBe(META.incarnation);
  });

  it('SB07-F1-OR-01: the faithful uninterrupted rejection path is accepted with full correlation', () => {
    const v = check(baseline);
    expect(v.violations).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.record).toEqual({ incarnation: META.incarnation, threadId: META.threadId, requestId: 0, turnId: META.turnId, itemId: META.itemId });
    const at = v.indices!;
    expect([at.request, at.reply, at.resolved, at.itemCompleted, at.turnCompleted]).toEqual([
      idx(baseline, isReq), idx(baseline, isReply), idx(baseline, isResolved), idx(baseline, isItem), idx(baseline, isTurn),
    ]);
    expect(at.request < at.reply && at.reply < at.resolved && at.resolved < at.itemCompleted && at.itemCompleted < at.turnCompleted).toBe(true);
  });

  it('SB07-F1-OR-02: unrelated other-thread notifications may interleave anywhere in the path', () => {
    const v = mutate((t) => {
      const base = t[idx(t, isReq)].at;
      insertAfter(t, idx(t, isReq), note('serverRequest/resolved', { threadId: OTHER_THREAD, requestId: 0 }, base + 0.01));
      insertAfter(t, idx(t, isResolved), note('item/completed', { threadId: OTHER_THREAD, turnId: 't-other', item: { type: 'commandExecution', id: META.itemId, status: 'completed' } }, base + 0.02));
      insertAfter(t, idx(t, isItem), note('turn/completed', { threadId: OTHER_THREAD, turn: { id: META.turnId, status: 'interrupted' } }, base + 0.03));
      insertAfter(t, idx(t, isItem), note('thread/status/changed', { threadId: OTHER_THREAD, status: { type: 'idle' } }, base + 0.04));
    });
    expect(v.violations).toEqual([]);
  });
});

describe('SB07-F1 oracle: mutation controls (each mutant rejected for its defect)', () => {
  const cases: Array<[string, (t: TranscriptEntry[]) => void, string]> = [
    // request
    ['request missing', (t) => { t.splice(idx(t, isReq), 1); }, 'request-missing'],
    ['request duplicated', (t) => { const i = idx(t, isReq); insertAfter(t, i, clone(t[i])); }, 'request-duplicate'],
    ['fresh-process request id is string "0" (consistently correlated)', (t) => { renumber(t, '0'); }, 'request-id-not-fresh'],
    ['fresh-process request id is 1 (consistently correlated)', (t) => { renumber(t, 1); }, 'request-id-not-fresh'],
    ['a prior server request invalidates the fresh-process probe', (t) => {
      const i = idx(t, isReq);
      const prior = clone(t[i]);
      prior.message.id = 99;
      prior.message.method = 'item/fileChange/requestApproval';
      prior.at -= 1;
      t.splice(i, 0, reraw(prior));
    }, 'request-not-first'],
    ['reply timestamp before request despite later transcript position', (t) => { t[idx(t, isReply)].at = t[idx(t, isReq)].at - 1; }, 'reply-time-invalid'],
    // reply
    ['reply missing', (t) => { t.splice(idx(t, isReply), 1); }, 'reply-missing'],
    ['reply duplicated', (t) => { const i = idx(t, isReply); insertAfter(t, i, clone(t[i])); }, 'reply-duplicate'],
    ['reply id string "0" for numeric request 0', (t) => { edit(t, isReply, (m) => { m.id = '0'; }); }, 'reply-missing'],
    ['reply message is the 8546530 method-name text', (t) => { edit(t, isReply, (m) => { m.error!.message = `item/commandExecution/requestApproval is not supported in exec mode for thread \`${META.threadId}\``; }); }, 'reply-message'],
    ['reply message without backticks', (t) => { edit(t, isReply, (m) => { m.error!.message = `command execution approval is not supported in exec mode for thread ${META.threadId}`; }); }, 'reply-message'],
    ['reply message names another thread', (t) => { edit(t, isReply, (m) => { m.error!.message = `command execution approval is not supported in exec mode for thread \`${OTHER_THREAD}\``; }); }, 'reply-message'],
    ['reply code -32603', (t) => { edit(t, isReply, (m) => { m.error!.code = -32603; }); }, 'reply-code'],
    ['reply carries a result', (t) => { edit(t, isReply, (m) => { m.result = {}; }); }, 'reply-shape'],
    ['reply bytes differ from the parity serialization', (t) => { t[idx(t, isReply)].raw = REPLY_BYTES.replace('{"id":0,', '{"id": 0,'); }, 'reply-bytes'],
    ['reply bytes not captured', (t) => { delete t[idx(t, isReply)].raw; }, 'reply-bytes'],
    ['reply after the 5000 ms deadline', (t) => { const r = t[idx(t, isReply)]; r.at = t[idx(t, isReq)].at + 5_000.5; }, 'reply-late'],
    ['reply from another process incarnation', (t) => { t[idx(t, isReply)].incarnation = 'other-incarnation'; }, 'reply-missing'],
    // resolution
    ['resolution missing', (t) => { t.splice(idx(t, isResolved), 1); }, 'resolved-missing'],
    ['resolution duplicated', (t) => { const i = idx(t, isResolved); insertAfter(t, i, clone(t[i])); }, 'resolved-duplicate'],
    ['resolution requestId string "0"', (t) => { edit(t, isResolved, (m) => { m.params!.requestId = '0'; }); }, 'resolved-malformed'],
    ['resolution requestId missing', (t) => { edit(t, isResolved, (m) => { delete m.params!.requestId; }); }, 'resolved-malformed'],
    ['resolution for another request on the thread', (t) => { edit(t, isResolved, (m) => { m.params!.requestId = 7; }); }, 'resolved-malformed'],
    ['resolution names another thread only', (t) => { edit(t, isResolved, (m) => { m.params!.threadId = OTHER_THREAD; }); }, 'resolved-missing'],
    ['resolution from another process incarnation', (t) => { t[idx(t, isResolved)].incarnation = 'previous-incarnation'; }, 'resolved-missing'],
    ['resolution last (8546530 expectation)', (t) => { const [e] = t.splice(idx(t, isResolved), 1); insertAfter(t, idx(t, isTurn), e); }, 'resolved-order'],
    ['resolution before the reply', (t) => { const [e] = t.splice(idx(t, isResolved), 1); t.splice(idx(t, isReply), 0, e); }, 'resolved-order'],
    // item completion
    ['item completion missing', (t) => { t.splice(idx(t, isItem), 1); }, 'item-missing'],
    ['item completion duplicated', (t) => { const i = idx(t, isItem); insertAfter(t, i, clone(t[i])); }, 'item-duplicate'],
    ['item completion for another item', (t) => { edit(t, isItem, (m) => { m.params!.item.id = 'call_other'; }); }, 'item-missing'],
    ['item completion with the wrong turn', (t) => { edit(t, isItem, (m) => { m.params!.turnId = 'turn-other'; }); }, 'item-malformed'],
    ['item status completed', (t) => { edit(t, isItem, (m) => { m.params!.item.status = 'completed'; }); }, 'item-status'],
    ['rejected command executed (exitCode 0)', (t) => { edit(t, isItem, (m) => { m.params!.item.exitCode = 0; }); }, 'command-executed'],
    ['rejected command executed (processId)', (t) => { edit(t, isItem, (m) => { m.params!.item.processId = '4242'; }); }, 'command-executed'],
    ['rejected command executed (output)', (t) => { edit(t, isItem, (m) => { m.params!.item.aggregatedOutput = 'sb07-esc\n'; }); }, 'command-executed'],
    ['item completion before resolution', (t) => { const [e] = t.splice(idx(t, isItem), 1); t.splice(idx(t, isResolved), 0, e); }, 'item-order'],
    // turn completion
    ['turn completion missing', (t) => { t.splice(idx(t, isTurn), 1); }, 'turn-missing'],
    ['turn completion duplicated', (t) => { const i = idx(t, isTurn); insertAfter(t, i, clone(t[i])); }, 'turn-duplicate'],
    ['turn completion for another turn', (t) => { edit(t, isTurn, (m) => { m.params!.turn.id = 'turn-other'; }); }, 'turn-missing'],
    ['turn completion names another thread', (t) => { edit(t, isTurn, (m) => { m.params!.threadId = OTHER_THREAD; }); }, 'turn-missing'],
    ['turn status interrupted', (t) => { edit(t, isTurn, (m) => { m.params!.turn.status = 'interrupted'; }); }, 'turn-status'],
    ['turn completion before item completion', (t) => { const [e] = t.splice(idx(t, isTurn), 1); t.splice(idx(t, isItem), 0, e); }, 'turn-order'],
    // host lane
    ['premature lane release: next turn/start before turn/completed', (t) => {
      const i = idx(t, isResolved);
      insertAfter(t, i, reraw({ dir: 'out', at: t[i].at + 0.01, message: { id: 99, method: 'turn/start', params: { threadId: META.threadId, input: [] } }, incarnation: META.incarnation }));
    }, 'lane-released-early'],
    ['cross-generation: correlated events from another incarnation', (t) => {
      const i = idx(t, isItem);
      insertAfter(t, i, { ...clone(t[i]), incarnation: 'previous-incarnation' });
    }, 'cross-incarnation'],
  ];

  it.each(cases)('SB07-F1-MUT: %s', (_name, f, code) => {
    const v = mutate(f);
    expect(v.ok).toBe(false);
    expect(v.violations).toContain(code);
  });

  it('SB07-F1-OR-03: the committed 8546530 SB-07 capture is rejected for its unfaithful reply (only relevant historical protocol rows retained)', () => {
    const old = readFileSync(new URL('../../fixtures/app-server/0.142.3/historical-bad-rejection.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TranscriptEntry);
    const tid = (old.find((e) => e.dir === 'in' && msg(e).method === 'item/commandExecution/requestApproval')!.message as Msg).params!.threadId as string;
    const v = checkSb07RejectionPath(old, { threadId: tid, incarnation: undefined });
    expect(v.ok).toBe(false);
    expect(v.violations).toEqual(expect.arrayContaining(['reply-message', 'reply-bytes']));
  });
});
