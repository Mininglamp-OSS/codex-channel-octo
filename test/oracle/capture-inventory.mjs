/**
 * Independent capture-proxy seal validation (TEST ONLY collection contract).
 * The ledger is a separate trusted tester/collector input, never derived here
 * from the supplied captures or host receipts. Source labels are descriptions,
 * not authentication: a live caller must obtain this seal from its independent
 * collector after closing the run and exhausting pagination. The checked-in
 * ledgers are tester-declared synthetic fixtures, not live attestations.
 */
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const sources = new Set(['independent-capture-proxy', 'independent-tester-synthetic']);

export function reconcileCaptureInventory(trace, ledger) {
  const reasons = [];
  const bad = reason => { if (!reasons.includes(reason)) reasons.push(reason); };
  if (!object(ledger)) return { complete: false, reasons: ['missing independent capture inventory'] };
  if (ledger.version !== 'capture-inventory-v1' || !sources.has(ledger.source) || ledger.sealed !== true) bad('unsupported or unsealed capture inventory');
  if (ledger.fixture !== trace.fixture) bad('fixture scope mismatch');
  const captures = Array.isArray(trace.captures) ? trace.captures : [];
  if (!Array.isArray(trace.captures)) bad('missing capture records');
  const pages = Array.isArray(ledger.pages) ? ledger.pages : [];
  const windows = Array.isArray(ledger.windows) ? ledger.windows : [];
  if (!Array.isArray(ledger.pages) || !Array.isArray(ledger.windows)) bad('missing pages or windows');
  if (!integer(ledger.declaredAttemptCount) || ledger.declaredAttemptCount !== captures.length) bad('attempt count gap');
  if (!integer(ledger.declaredPageCount) || ledger.declaredPageCount !== pages.length) bad('page count gap');
  const ordinals = [], cursors = new Set();
  if (pages.length ? ledger.firstCursor !== pages[0]?.cursor : ledger.firstCursor !== null) bad('cursor head mismatch');
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (!object(p) || typeof p.cursor !== 'string' || !p.cursor || cursors.has(p.cursor)) { bad('missing or overlapping cursor'); continue; }
    cursors.add(p.cursor);
    if (p.next !== (i + 1 < pages.length ? pages[i + 1]?.cursor : null)) bad('broken cursor chain');
    if (!Array.isArray(p.requestOrdinals) || !p.requestOrdinals.length || !p.requestOrdinals.every(integer)) bad('missing or malformed ordinal page');
    else ordinals.push(...p.requestOrdinals);
  }
  if (ordinals.length !== ledger.declaredAttemptCount || new Set(ordinals).size !== ordinals.length) bad('ordinal count gap or overlap');
  const actual = captures.map(c => c?.requestOrdinal);
  if (!actual.every(integer) || new Set(actual).size !== actual.length) bad('duplicate or malformed capture ordinal');
  if (JSON.stringify([...actual].sort((a,b) => a-b)) !== JSON.stringify([...ordinals].sort((a,b) => a-b))) bad('missing or extra captured ordinal');
  let total = 0;
  for (const window of windows) {
    if (!object(window) || typeof window.run !== 'string' || !window.run || typeof window.incarnation !== 'string' || !window.incarnation
      || !integer(window.firstOrdinal) || !integer(window.lastOrdinal) || !integer(window.attemptCount)
      || window.attemptCount < 1 || window.lastOrdinal - window.firstOrdinal + 1 !== window.attemptCount) { bad('malformed capture window'); continue; }
    total += window.attemptCount;
    const records = captures.filter(c => c?.run === window.run && c?.incarnation === window.incarnation
      && c.requestOrdinal >= window.firstOrdinal && c.requestOrdinal <= window.lastOrdinal);
    if (records.length !== window.attemptCount) bad('run/process window count gap');
  }
  if (total !== ledger.declaredAttemptCount) bad('window total count gap');
  for (const capture of captures) {
    const required = ['fixture','run','incarnation','requestOrdinal','kind','occurrence','ordinal','index','count','senderUid','target','requestBodyHash','httpStatus','responseMessageId','transportOutcome'];
    if (!object(capture) || required.some(k => !Object.hasOwn(capture,k))) { bad('incomplete capture record'); continue; }
    if (capture.fixture !== ledger.fixture) bad('capture fixture scope mismatch');
    const matches = windows.filter(w => object(w) && capture.run === w.run && capture.incarnation === w.incarnation
      && capture.requestOrdinal >= w.firstOrdinal && capture.requestOrdinal <= w.lastOrdinal);
    if (matches.length !== 1) bad('missing or overlapping run/process scope');
  }
  return { complete: reasons.length === 0, reasons, observedAttempts: captures.length };
}
