/**
 * TEST ONLY transcript oracle for SB-07 (R8 §6.3 as amended by A-R8-SB07-01).
 *
 * Pure function over a recorded JSONL transcript (test/harness/jsonl-client.ts
 * entries). It checks the pinned 0.142.3 uninterrupted exec-parity rejection
 * path as one CORRELATED causal sequence:
 *
 *   item/commandExecution/requestApproval (server request, id 0 in a fresh process)
 *   → host error reply {"id":0,"error":{"code":-32000,"message":"command execution
 *     approval is not supported in exec mode for thread `<threadId>`"}} within 5000 ms
 *   → serverRequest/resolved {threadId, requestId}        (by incarnation/thread/request)
 *   → item/completed commandExecution status=failed        (by thread/turnId/itemId)
 *   → turn/completed status=completed                      (by thread/turn.id)
 *
 * Unrelated notifications (other threads, other items) may interleave; a
 * missing, duplicated, wrongly correlated, malformed or reordered required
 * event is a violation. Ids are compared with their JSON type (number 0 is
 * not string "0") and never by truthiness.
 *
 * This oracle judges transcripts only. The host runtime obligations it
 * reflects (answer every server request, retire on resolution, release the
 * lane only on turn completion) are pending DEV-03/04 (HB-B7); nothing here
 * implements or claims them.
 */
import type { RpcMessage, TranscriptEntry } from '../jsonl-client.js';

export const SB07_METHOD = 'item/commandExecution/requestApproval';
export const SB07_CODE = -32000;
export const SB07_DEADLINE_MS = 5_000;

export interface Sb07Expectation {
  /** Thread the escalated turn runs on. */
  threadId: string;
  /** Process incarnation the path must stay within; undefined accepts entries without one (pre-amendment transcripts). */
  incarnation: string | undefined;
}

export interface Sb07Record { incarnation: string | undefined; threadId: string; requestId: number | string; turnId: string; itemId: string }

export interface Sb07Verdict {
  ok: boolean;
  violations: string[];
  record?: Sb07Record;
  indices?: { request: number; reply: number; resolved: number; itemCompleted: number; turnCompleted: number };
}

type Params = Record<string, unknown> & { threadId?: unknown; turnId?: unknown; itemId?: unknown; requestId?: unknown; item?: Record<string, unknown>; turn?: Record<string, unknown> };
const params = (m: RpcMessage): Params => (m.params && typeof m.params === 'object' ? m.params as Params : {});
/** Typed id equality: same JSON type and value; 0 and "0" differ. */
const sameId = (a: unknown, b: unknown): boolean => (typeof a === 'number' || typeof a === 'string') && typeof a === typeof b && a === b;
const isNotification = (e: TranscriptEntry) => e.dir === 'in' && e.message.method !== undefined && e.message.id === undefined;
const isServerRequest = (e: TranscriptEntry) => e.dir === 'in' && e.message.method !== undefined && e.message.id !== undefined;

/** The parity reply line the host must write for request `id` on `threadId`. */
export function sb07ReplyBytes(id: number | string, threadId: string): string {
  return JSON.stringify({ id, error: { code: SB07_CODE, message: `command execution approval is not supported in exec mode for thread \`${threadId}\`` } });
}

export function checkSb07RejectionPath(trace: TranscriptEntry[], exp: Sb07Expectation): Sb07Verdict {
  const violations: string[] = [];
  const v = (code: string) => { if (!violations.includes(code)) violations.push(code); };
  const sameProc = (e: TranscriptEntry) => e.incarnation === exp.incarnation;
  const onThread = (e: TranscriptEntry) => params(e.message).threadId === exp.threadId;

  // ── request ──────────────────────────────────────────────────────────────
  const requests = trace.map((e, i) => [e, i] as const).filter(([e]) => isServerRequest(e) && e.message.method === SB07_METHOD && onThread(e));
  for (const [e] of requests) if (!sameProc(e)) v('cross-incarnation');
  const own = requests.filter(([e]) => sameProc(e));
  if (own.length === 0) { v('request-missing'); return { ok: false, violations }; }
  if (own.length > 1) v('request-duplicate');
  const [req, iReq] = own[0];
  const rp = params(req.message);
  const requestId = req.message.id as number | string;
  // A fresh process (no earlier server request in this incarnation) numbers its first request 0.
  const earlier = trace.slice(0, iReq).filter((e) => isServerRequest(e) && sameProc(e));
  if (earlier.length !== 0) v('request-not-first');
  if (!sameId(requestId, 0)) v('request-id-not-fresh');
  if (typeof rp.turnId !== 'string' || typeof rp.itemId !== 'string') { v('request-malformed'); return { ok: false, violations }; }
  const record: Sb07Record = { incarnation: exp.incarnation, threadId: exp.threadId, requestId, turnId: rp.turnId, itemId: rp.itemId };

  // ── host reply ───────────────────────────────────────────────────────────
  const outIdLike = (e: TranscriptEntry) => e.dir === 'out' && e.message.method === undefined && (e.message.id === requestId || String(e.message.id) === String(requestId));
  const replies = trace.map((e, i) => [e, i] as const).filter(([e, i]) => i > iReq && outIdLike(e));
  for (const [e] of replies) if (!sameProc(e)) v('cross-incarnation');
  const typed = replies.filter(([e]) => sameProc(e) && sameId(e.message.id, requestId));
  let iReply = -1;
  if (typed.length === 0) v('reply-missing');
  else {
    if (typed.length > 1) v('reply-duplicate');
    const [reply, i] = typed[0];
    iReply = i;
    const m = reply.message;
    if (m.result !== undefined || m.error === undefined) v('reply-shape');
    if (m.error?.code !== SB07_CODE) v('reply-code');
    if (m.error?.message !== `command execution approval is not supported in exec mode for thread \`${exp.threadId}\``) v('reply-message');
    if (reply.raw !== sb07ReplyBytes(requestId, exp.threadId)) v('reply-bytes');
    if (!Number.isFinite(reply.at) || !Number.isFinite(req.at) || reply.at < req.at) v('reply-time-invalid');
    if (!(reply.at - req.at <= SB07_DEADLINE_MS)) v('reply-late');
  }

  // ── resolution (by incarnation, thread and typed request id from the saved record) ──
  const resolvedOnThread = trace.map((e, i) => [e, i] as const).filter(([e]) => isNotification(e) && e.message.method === 'serverRequest/resolved' && onThread(e));
  for (const [e] of resolvedOnThread) {
    if (!sameProc(e)) { if (sameId(params(e.message).requestId, requestId)) v('cross-incarnation'); continue; }
    if (!sameId(params(e.message).requestId, requestId)) v('resolved-malformed');
  }
  const resolved = resolvedOnThread.filter(([e]) => sameProc(e) && sameId(params(e.message).requestId, requestId));
  let iResolved = -1;
  if (resolved.length === 0) v('resolved-missing');
  else {
    if (resolved.length > 1) v('resolved-duplicate');
    iResolved = resolved[0][1];
    if (iResolved < iReq || (iReply >= 0 && iResolved < iReply)) v('resolved-order');
  }

  // ── item completion (by thread, turn id and item id) ─────────────────────
  const itemEvents = trace.map((e, i) => [e, i] as const).filter(([e]) => isNotification(e) && e.message.method === 'item/completed' && onThread(e) && params(e.message).item?.id === record.itemId);
  for (const [e] of itemEvents) {
    if (!sameProc(e)) { v('cross-incarnation'); continue; }
    if (params(e.message).turnId !== record.turnId) v('item-malformed');
  }
  const items = itemEvents.filter(([e]) => sameProc(e) && params(e.message).turnId === record.turnId);
  let iItem = -1;
  if (items.length === 0) v('item-missing');
  else {
    if (items.length > 1) v('item-duplicate');
    const [e, i] = items[0];
    iItem = i;
    const item = params(e.message).item!;
    if (item.type !== 'commandExecution' || item.status !== 'failed') v('item-status');
    // The rejected command never ran.
    if (item.processId !== null || item.aggregatedOutput !== null || item.exitCode !== null) v('command-executed');
    if (iResolved < 0 || iItem < iResolved) v('item-order');
  }
  if (iResolved >= 0 && iItem >= 0 && iResolved > iItem) v('resolved-order');
  // No execution output may be streamed for the rejected item.
  if (trace.some((e) => sameProc(e) && isNotification(e) && e.message.method === 'item/commandExecution/outputDelta' && params(e.message).itemId === record.itemId)) v('command-executed');

  // ── turn completion (by thread and turn.id) ──────────────────────────────
  const turnEvents = trace.map((e, i) => [e, i] as const).filter(([e]) => isNotification(e) && e.message.method === 'turn/completed' && onThread(e) && params(e.message).turn?.id === record.turnId);
  for (const [e] of turnEvents) if (!sameProc(e)) v('cross-incarnation');
  const turns = turnEvents.filter(([e]) => sameProc(e));
  let iTurn = -1;
  if (turns.length === 0) v('turn-missing');
  else {
    if (turns.length > 1) v('turn-duplicate');
    iTurn = turns[0][1];
    if (params(turns[0][0].message).turn?.status !== 'completed') v('turn-status');
    if (iItem < 0 || iTurn < iItem) v('turn-order');
  }

  // ── host lane: the thread is busy until its turn completes ──────────────
  const laneEnd = iTurn >= 0 ? iTurn : trace.length;
  if (trace.slice(iReq + 1, laneEnd).some((e) => e.dir === 'out' && sameProc(e) && e.message.method === 'turn/start' && onThread(e))) v('lane-released-early');

  return {
    ok: violations.length === 0,
    violations,
    record,
    ...(violations.length === 0 ? { indices: { request: iReq, reply: iReply, resolved: iResolved, itemCompleted: iItem, turnCompleted: iTurn } } : {}),
  };
}
