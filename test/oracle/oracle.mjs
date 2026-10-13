/**
 * Independent all-attempt / all-segment delivery oracle, v1 (R8 §10.10).
 *
 * Tester-owned and independent of the host: the expected inventory comes from
 * the tester's script, attempts from the outbound capture proxy, and stored
 * messages from complete paginated channel read-back. Host receipts are ignored
 * for selection (they may be reconciled afterwards, never trusted).
 *
 *   evaluateDelivery({ fixture, expected, captures, inventory }, captureInventory) → report
 * The separate inventory is sealed by the independent collector, never inferred
 * from captures. Missing or inconsistent collection evidence cannot pass.
 */
import { createHash } from 'node:crypto';
import { reconcileCaptureInventory } from './capture-inventory.mjs';

const MARKER_RE = /^\[DLY f=(\S+) o=(\S+) r=(\S+) k=(\S+) m=(\d{6}) s=(\d{6})\/(\d{6})\]/;
const AMBIGUOUS = new Set(['disconnect', 'timeout', 'reset']);

export function formatMarker({ fixture, occurrence, run, kind, ordinal, index, count }) {
  const p6 = (n) => String(n).padStart(6, '0');
  return `[DLY f=${fixture} o=${occurrence} r=${run} k=${kind} m=${p6(ordinal)} s=${p6(index)}/${p6(count)}]`;
}

export function parseMarker(text) {
  const m = MARKER_RE.exec(String(text ?? ''));
  if (!m) return null;
  return { fixture: m[1], occurrence: m[2], run: m[3], kind: m[4], ordinal: Number(m[5]), index: Number(m[6]), count: Number(m[7]) };
}

export const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const identityKey = (i) => [i.fixture, i.occurrence, i.run, i.kind, i.ordinal, i.index].join('|');
const sameTarget = (a, b) => a && b && a.channelId === b.channelId && a.channelType === b.channelType;

export function evaluateDelivery(trace, captureInventory) {
  const violations = [];
  const counts = {
    permittedNetworkRetries: 0, duplicateLogicalAttempts: 0, duplicateCommittedIdentities: 0,
    unexpectedTargetOrBody: 0, missingConfirmedSegments: 0, unresolvedUnknowns: 0,
  };
  const v = (code, detail) => violations.push({ code, ...detail });
  const expected = new Map(trace.expected.map((e) => [identityKey({ fixture: trace.fixture, ...e.identity }), e]));
  const captureCompleteness = reconcileCaptureInventory(trace, captureInventory);

  // 1. Inventory completeness: unbroken cursor chain, declared page count, no overlap.
  const inv = trace.inventory;
  let complete = inv.complete === true && inv.pages.length === inv.declaredPageCount;
  for (let i = 0; i < inv.pages.length; i++) {
    const next = inv.pages[i + 1];
    if (next ? inv.pages[i].next !== next.cursor : inv.pages[i].next !== null) complete = false;
  }
  const records = inv.pages.flatMap((p) => p.records);
  if (new Set(records.map((r) => r.messageId)).size !== records.length) complete = false;

  // 2. Every stored message maps to exactly one permitted identity with the right target/sender/body.
  const stored = new Map();
  for (const r of records) {
    const marker = parseMarker(r.fixtureMarker);
    const e = marker && marker.fixture === trace.fixture ? expected.get(identityKey(marker)) : undefined;
    if (!e) { v('unexpected-delivery', { messageId: r.messageId }); counts.unexpectedTargetOrBody++; continue; }
    if (!sameTarget(e.target, { channelId: r.channelId, channelType: r.channelType })) { v('wrong-target', { messageId: r.messageId }); counts.unexpectedTargetOrBody++; continue; }
    if (e.senderUid !== r.senderUid) { v('wrong-sender', { messageId: r.messageId }); counts.unexpectedTargetOrBody++; continue; }
    if (sha256(e.body) !== r.payloadHash) { v('unexpected-body', { messageId: r.messageId }); counts.unexpectedTargetOrBody++; continue; }
    const k = identityKey(marker);
    stored.set(k, (stored.get(k) ?? 0) + 1);
  }

  // 3. Per expected identity: committed count by outcome class.
  for (const [k, e] of expected) {
    const n = stored.get(k) ?? 0;
    if (e.outcome === 'suppressed') { if (n > 0) v('unexpected-delivery', { identity: k }); continue; }
    if (n > 1) { v('duplicate-committed', { identity: k, observed: n }); counts.duplicateCommittedIdentities++; continue; }
    // An incomplete read-back cannot prove absence: missing segments stay pending, not failed.
    if (e.outcome === 'confirmed' && n === 0 && complete) { v('missing-confirmed-segment', { identity: k }); counts.missingConfirmedSegments++; }
    if (e.outcome === 'unknown') counts.unresolvedUnknowns++;
  }

  // 4. Every captured attempt: permitted retries only, never after ambiguity or restart.
  const attempts = new Map();
  for (const c of trace.captures) {
    const k = identityKey({ fixture: c.fixture, occurrence: c.occurrence, run: c.run, kind: c.kind, ordinal: c.ordinal, index: c.index });
    if (!expected.has(k)) { v('unexpected-attempt', { requestOrdinal: c.requestOrdinal }); continue; }
    if (!attempts.has(k)) attempts.set(k, []);
    attempts.get(k).push(c);
  }
  // A complete read-back is not a complete attempt log. Independently sealed
  // counts/cursors/windows must reconcile, and stored deliveries need matching
  // capture identity, sender, target, segment count and payload evidence.
  const matches = (c, e) => sameTarget(c.target, e.target) && c.senderUid === e.senderUid
    && c.count === e.identity.count && (c.serverNormalizedPayloadHash ?? c.requestBodyHash) === sha256(e.body);
  for (const [key, list] of attempts) for (const c of list) {
    if (!matches(c, expected.get(key))) v('attempt-mismatch', { requestOrdinal: c.requestOrdinal });
  }
  for (const r of records) {
    const marker = parseMarker(r.fixtureMarker);
    const key = marker && identityKey(marker);
    const e = expected.get(key);
    if (!e || !sameTarget(e.target, r) || e.senderUid !== r.senderUid || sha256(e.body) !== r.payloadHash) continue;
    const captured = (attempts.get(key) ?? []).some(c => matches(c, e)
      && c.transportOutcome !== 'prewrite-failure' && c.httpStatus !== 429
      && (c.responseMessageId == null || c.responseMessageId === r.messageId));
    if (!captured) v('uncaptured-delivery', { identity: key, messageId: r.messageId });
  }
  for (const [k, list] of attempts) {
    const e = expected.get(k);
    if (e.outcome === 'suppressed') { v('unexpected-attempt', { identity: k }); continue; }
    list.sort((a, b) => a.requestOrdinal - b.requestOrdinal);
    let r429 = 0;
    let prewrite = 0;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (cur.incarnation !== list[0].incarnation) { v('resend-after-restart', { identity: k, requestOrdinal: cur.requestOrdinal }); continue; }
      if (cur.requestBodyHash !== prev.requestBodyHash || cur.clientMsgNo !== prev.clientMsgNo) { v('changed-retry-payload', { identity: k, requestOrdinal: cur.requestOrdinal }); continue; }
      if (prev.httpStatus === 429 && r429 < 2) { r429++; counts.permittedNetworkRetries++; continue; }
      if (prev.transportOutcome === 'prewrite-failure' && prewrite < 1) { prewrite++; counts.permittedNetworkRetries++; continue; }
      if (AMBIGUOUS.has(prev.transportOutcome) || (prev.httpStatus ?? 0) >= 500) { v('retry-after-ambiguity', { identity: k, requestOrdinal: cur.requestOrdinal }); continue; }
      v('duplicate-logical-attempt', { identity: k, requestOrdinal: cur.requestOrdinal });
      counts.duplicateLogicalAttempts++;
    }
  }

  if (!complete) violations.push({ code: 'incomplete-inventory' });
  if (!captureCompleteness.complete) violations.push({ code: 'incomplete-capture-inventory', reasons: captureCompleteness.reasons });
  const failing = violations.filter(x => x.code !== 'incomplete-inventory' && x.code !== 'incomplete-capture-inventory');
  const verdict = failing.length > 0 ? 'fail' : !complete || !captureCompleteness.complete ? 'pending' : counts.unresolvedUnknowns > 0 ? 'unknown' : 'pass';
  return { verdict, violations, counts, captureCompleteness };
}
