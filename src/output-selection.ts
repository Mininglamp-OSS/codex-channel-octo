/**
 * Output Selection — picks the ONE user-facing reply for a turn from the typed
 * bridge events (see `queryAgentEvents` in agent-bridge.ts).
 *
 * Pure and synchronous: no I/O, no logging of message text. index.ts feeds
 * every bridge event into an OutputCollector, calls `select()` once, and hands
 * the same `SelectedOutput.text` to both delivery (StreamRelay) and response
 * history (`appendAssistant`), so the two sinks cannot diverge.
 *
 * Pool eligibility (applied before the selection table):
 *  - `F` is the final attempt of the call. `P` = messages of `F`.
 *  - `L` = messages of legacy attempts `F` explicitly continues (lineage,
 *    walked through `attempt_start.continues`; the current bridge emits null). Attempts with
 *    `continues: null` other than `F` (e.g. a stale-resume attempt replaced by
 *    a fresh retry) are never eligible.
 *  - Selection pool `S` uses useful primary messages, otherwise useful lineage
 *    messages. In final mode formatting-only text is not useful. Useful primary
 *    output excludes lineage. An empty pool without ancestors is primary.
 *  - Messages with empty text are ignored. Mode final also ignores whitespace-only
 *    text when choosing the pool and candidates; compatibility modes do not.
 *
 * Selection table (top-down; the first non-empty result wins):
 *  - R1 `phase`: known `final_answer` messages of `S`.
 *  - Mode final then keeps the last non-commentary item (or last commentary
 *    fallback), regardless of earlier message lengths.
 *    Partial and commentary fallbacks have distinct diagnostic sources.
 *  - R2 `trailing` (mode `heuristic` only; requires `S = P` and a completed
 *    turn): non-commentary messages of `S` whose first-sight seq is greater than
 *    the first-sight seq of the last work item of `F`. Abandoned for R3 when a
 *    dropped non-commentary message is longer than
 *    `max(400, 2 × selectedLength)` (substantive-loss guard, lengths only).
 *    When `F` has no work item, the last work seq is negative infinity, so
 *    every message is trailing (a no-work `commentary → final` turn delivers
 *    both messages).
 *  - R3 `unclassified_all`: all non-commentary messages of `S`.
 *  - R4 `commentary_last_resort`: known commentary of `S`.
 *  - R5 `empty`: `''` (the caller sends the "No response generated" notice).
 *
 * R2 is a heuristic based on ordering only. It is NOT a final-output signal;
 * only R1 (a runtime `phase` field, absent in SDK/CLI 0.142.3) is.
 *
 * Mode `final` is the default with the explicit last-message fallback above.
 * Mode `phase` (compatibility) is the table without R2. Mode `legacy` bypasses the
 * table and reproduces the baseline content: messages of `F` only, all phases,
 * first-seen order, joined with `''`. Every other mode joins with `\n\n`.
 *
 * The cap (`capSelected`) is applied once here, in every mode, and its output
 * never exceeds `maxChars`, so StreamRelay's own truncation never fires on a
 * selected payload.
 */

import type { AgentOutputEvent, MessagePhase } from './agent-bridge.js';
import { decodeArtifactEnvelope, type ImageArtifact } from './artifacts.js';

/** Truncation suffix appended to an over-limit reply. Shared with stream-relay. */
export const TRUNCATION_SUFFIX = '\n\n[response truncated]';

/** Default maximum response length (Q32). Shared with stream-relay. */
export const DEFAULT_MAX_RESPONSE_CHARS = 524_288; // 512 KB

export type OutputSelectionMode = 'final' | 'phase' | 'heuristic' | 'legacy';

export const OUTPUT_SELECTION_MODES: readonly OutputSelectionMode[] = ['final', 'phase', 'heuristic', 'legacy'];

export const DEFAULT_OUTPUT_SELECTION_MODE: OutputSelectionMode = 'final';

export type SelectionSource =
  | 'phase'
  | 'last_message'
  | 'last_message_partial'
  | 'commentary_last'
  | 'commentary_last_partial'
  | 'trailing'
  | 'unclassified_all'
  | 'commentary_last_resort'
  | 'legacy_all'
  | 'empty';

export interface SelectedOutput {
  /** The ONE user-facing payload: pre-mention-resolution, post-cap. */
  text: string;
  source: SelectionSource;
  /** Which pool the selection came from. */
  pool: 'primary' | 'lineage';
  /** Item ids included, in seq order. */
  messageIds: string[];
  /** Unselected candidates (count only). Final counts useful items in its pool;
   * compatibility modes retain their historical cross-pool non-empty count. */
  droppedMessageCount: number;
  truncated: boolean;
  artifacts: ReadonlyArray<ImageArtifact>;
}

/** Length floor of the substantive-loss guard (R2 only). */
export const SUBSTANTIVE_GUARD_MIN_CHARS = 400;

const JOIN = '\n\n';

interface CollectedMessage {
  itemId: string;
  seq: number;
  text: string;
  phase: MessagePhase;
}

interface AttemptRecord {
  attempt: number;
  continues: number | null;
  ended: boolean;
  terminal: 'completed' | 'no_terminal';
  /** Keyed by itemId; a later snapshot replaces text in place, keeps seq. */
  messages: Map<string, CollectedMessage>;
  /** First-sight seq of the last work item; -Infinity when there is none. */
  lastWorkSeq: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Cap a selected payload to at most `max` UTF-16 code units.
 *
 * - `s.length <= max`: unchanged (same trigger as the baseline relay).
 * - `max > 2 × suffix length` (45 and up): headroom mode, the body is cut at
 *   `max − suffix length` and the suffix appended.
 * - `max` 1–44: small-limit mode, the body is cut at `max` with no suffix.
 * - The cut backs off one unit rather than leave an orphan high surrogate; if
 *   that leaves no body (`max = 1` with a leading astral char) the result is
 *   `'…'`.
 */
export function capSelected(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  let bodyLen: number;
  let suffix: string;
  if (max > 2 * TRUNCATION_SUFFIX.length) {
    bodyLen = max - TRUNCATION_SUFFIX.length;
    suffix = TRUNCATION_SUFFIX;
  } else {
    bodyLen = max;
    suffix = '';
  }
  if (isHighSurrogate(s.charCodeAt(bodyLen - 1))) bodyLen--;
  if (bodyLen === 0) return { text: '…', truncated: true };
  return { text: s.slice(0, bodyLen) + suffix, truncated: true };
}

/** True when `max` is too small to carry the truncation suffix (small-limit mode). */
export function isSmallResponseLimit(max: number): boolean {
  return max <= 2 * TRUNCATION_SUFFIX.length;
}

function bySeq(a: CollectedMessage, b: CollectedMessage): number {
  return a.seq - b.seq;
}

function joinedLength(msgs: CollectedMessage[], sep: string): number {
  if (msgs.length === 0) return 0;
  return msgs.reduce((n, m) => n + m.text.length, 0) + sep.length * (msgs.length - 1);
}

/**
 * Accumulates bridge events for one `queryAgentEvents` call and computes the
 * single SelectedOutput. Never logs or exposes message text.
 */
export class OutputCollector {
  private readonly attempts = new Map<number, AttemptRecord>();
  private finalAttempt: number | undefined;
  private artifactRequestId?: string;

  push(ev: AgentOutputEvent): void {
    switch (ev.kind) {
      case 'attempt_start': {
        this.attempts.set(ev.attempt, {
          attempt: ev.attempt,
          continues: ev.continues,
          ended: false,
          terminal: 'no_terminal',
          messages: new Map(),
          lastWorkSeq: Number.NEGATIVE_INFINITY,
        });
        this.finalAttempt = ev.attempt;
        break;
      }
      case 'message': {
        const rec = this.attempts.get(ev.attempt);
        if (!rec) return;
        const prev = rec.messages.get(ev.itemId);
        rec.messages.set(ev.itemId, {
          itemId: ev.itemId,
          seq: prev ? prev.seq : ev.seq,
          text: ev.text,
          phase: ev.phase,
        });
        break;
      }
      case 'work': {
        const rec = this.attempts.get(ev.attempt);
        if (!rec) return;
        if (ev.seq > rec.lastWorkSeq) rec.lastWorkSeq = ev.seq;
        break;
      }
      case 'attempt_end': {
        const rec = this.attempts.get(ev.attempt);
        if (!rec) return;
        rec.ended = true;
        rec.terminal = ev.terminal;
        break;
      }
    }
  }

  /** Number of attempts observed (for counts-only logging). */
  get attemptCount(): number {
    return this.attempts.size;
  }

  select(opts: { mode: OutputSelectionMode; maxChars: number; artifactRequestId?: string }): SelectedOutput {
    const F = this.finalAttempt === undefined ? undefined : this.attempts.get(this.finalAttempt);
    // Only complete primary final-mode runs may authorize artifacts. Compatibility
    // joins, lineage and partial replies must not acquire new upload semantics.
    this.artifactRequestId = opts.mode === 'final' && F?.terminal === 'completed' ? opts.artifactRequestId : undefined;
    if (!F) return this.finish([], 'empty', 'primary', 0, opts.maxChars, JOIN);

    const P = this.nonEmptyMessages(F);
    const lineage = this.lineageOf(F);
    const L = lineage.flatMap((a) => this.nonEmptyMessages(a)).sort(bySeq);
    if (opts.mode === 'legacy') {
      return this.finish(P, P.length > 0 ? 'legacy_all' : 'empty', 'primary', P.length + L.length, opts.maxChars, '');
    }

    // Ignore formatting-only items in the default mode, without modifying text
    // that contains visible content (including legitimate joiners inside words).
    const useful = (m: CollectedMessage): boolean =>
      opts.mode !== 'final' || /[^\s\p{Default_Ignorable_Code_Point}]/u.test(m.text);
    const primary = P.filter(useful);
    const inherited = L.filter(useful);
    let pool: 'primary' | 'lineage' = 'primary';
    if (opts.mode === 'final') {
      if (primary.length === 0 && inherited.length > 0) pool = 'lineage';
    } else if (P.length === 0) {
      pool = 'lineage';
    }
    const eligible = pool === 'primary' ? P : L;
    const S = eligible.filter(useful);
    const eligibleCount = opts.mode === 'final' ? S.length : P.length + L.length;
    const kFinal = S.filter((m) => m.phase === 'final_answer');
    const kComm = S.filter((m) => m.phase === 'commentary');
    const nonComm = S.filter((m) => m.phase !== 'commentary');

    // R1: proven final output.
    if (kFinal.length > 0) {
      return this.finish(kFinal, 'phase', pool, eligibleCount, opts.maxChars, JOIN);
    }

    // Exec JSONL 0.142/0.162 omits phase. This is an explicit ordering
    // fallback, not inferred provider intent. Preserve explicit multipart finals
    // above. Length cannot distinguish progress from an earlier answer; never
    // restore unknown messages just because they are longer than the last item.
    if (opts.mode === 'final') {
      const last = nonComm.at(-1);
      const partial = pool === 'lineage' || F.terminal !== 'completed';
      if (last) {
        const source = partial || last.phase === 'partial_answer'
          ? 'last_message_partial' : 'last_message';
        return this.finish([last], source, pool, eligibleCount, opts.maxChars, JOIN);
      }
      // Commentary is a genuine last resort: a blank non-commentary item must
      // not newly expose labeled narration merely because it was filtered out.
      const commentary = eligible.every(m => m.phase === 'commentary') ? kComm.at(-1) : undefined;
      if (commentary) {
        return this.finish([commentary], partial ? 'commentary_last_partial' : 'commentary_last', pool, eligibleCount, opts.maxChars, JOIN);
      }
      return this.finish([], 'empty', pool, eligibleCount, opts.maxChars, JOIN);
    }

    // R2: trailing-run heuristic (opt-in).
    if (opts.mode === 'heuristic' && pool === 'primary' && F.terminal === 'completed') {
      const trailing = nonComm.filter((m) => m.seq > F.lastWorkSeq);
      if (trailing.length > 0) {
        const kept = new Set(trailing.map((m) => m.itemId));
        const threshold = Math.max(SUBSTANTIVE_GUARD_MIN_CHARS, 2 * joinedLength(trailing, JOIN));
        const guardTripped = nonComm.some((m) => !kept.has(m.itemId) && m.text.length > threshold);
        if (!guardTripped) {
          return this.finish(trailing, 'trailing', pool, eligibleCount, opts.maxChars, JOIN);
        }
      }
    }

    // R3: everything not known to be commentary.
    if (nonComm.length > 0) {
      return this.finish(nonComm, 'unclassified_all', pool, eligibleCount, opts.maxChars, JOIN);
    }

    // R4: known commentary, only when the pool has nothing else.
    if (kComm.length > 0) {
      return this.finish(kComm, 'commentary_last_resort', pool, eligibleCount, opts.maxChars, JOIN);
    }

    // R5
    return this.finish([], 'empty', pool, eligibleCount, opts.maxChars, JOIN);
  }

  private nonEmptyMessages(rec: AttemptRecord): CollectedMessage[] {
    return [...rec.messages.values()].filter((m) => typeof m.text === 'string' && m.text.length > 0).sort(bySeq);
  }

  /** `continues` ancestors of `F`, excluding `F`. */
  private lineageOf(F: AttemptRecord): AttemptRecord[] {
    const out: AttemptRecord[] = [];
    const seen = new Set<number>([F.attempt]);
    let next = F.continues;
    while (next !== null && !seen.has(next)) {
      const rec = this.attempts.get(next);
      if (!rec) break;
      out.push(rec);
      seen.add(next);
      next = rec.continues;
    }
    return out;
  }

  private finish(
    selected: CollectedMessage[],
    source: SelectionSource,
    pool: 'primary' | 'lineage',
    eligibleCount: number,
    maxChars: number,
    sep: string,
  ): SelectedOutput {
    const joined = selected.map((m) => m.text).join(sep);
    const decoded = this.artifactRequestId && pool === 'primary' && !source.includes('partial') && !source.startsWith('commentary')
      ? decodeArtifactEnvelope(joined, this.artifactRequestId) : { text: joined, artifacts: [] };
    const capped = capSelected(decoded.text, maxChars);
    return {
      text: capped.text,
      source,
      pool,
      messageIds: selected.map((m) => m.itemId),
      droppedMessageCount: eligibleCount - selected.length,
      truncated: capped.truncated,
      artifacts: decoded.artifacts,
    };
  }
}

/** Counts-only summary line for logs. Never includes message text. */
export function describeSelection(sel: SelectedOutput, mode: OutputSelectionMode, attempts: number): string {
  return (
    `[output-selection] mode=${mode} source=${sel.source} pool=${sel.pool} ` +
    `kept=${sel.messageIds.length} dropped=${sel.droppedMessageCount} chars=${sel.text.length} ` +
    `truncated=${sel.truncated} attempts=${attempts}`
  );
}
