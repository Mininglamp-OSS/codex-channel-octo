/**
 * output-selection tests — the pure selection table (R1–R5), attempt/lineage
 * eligibility, legacy compatibility and the cap rule. No I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  OutputCollector,
  DEFAULT_OUTPUT_SELECTION_MODE,
  capSelected,
  describeSelection,
  isSmallResponseLimit,
  TRUNCATION_SUFFIX,
  type OutputSelectionMode,
} from '../output-selection.js';
import type { AgentOutputEvent, MessagePhase } from '../agent-bridge.js';

const BIG = 524_288;

// ─── Script builder ──────────────────────────────────────────────────────────
// Mirrors the bridge contract: one seq counter per call, first-sight seq per
// (attempt, itemId), work once per item.
class Script {
  readonly events: AgentOutputEvent[] = [];
  private seq = 0;
  private cur = -1;
  private next = 0;
  private readonly sight = new Map<string, number>();

  start(reason: 'initial' | 'request_retry' = 'initial', continues: number | null = null): this {
    this.cur = this.next++;
    this.events.push({ kind: 'attempt_start', attempt: this.cur, reason, continues });
    return this;
  }
  private seqOf(id: string): number {
    const k = `${this.cur}:${id}`;
    const prev = this.sight.get(k);
    if (prev !== undefined) return prev;
    const s = this.seq++;
    this.sight.set(k, s);
    return s;
  }
  msg(id: string, text: string, phase: MessagePhase = 'unknown'): this {
    this.events.push({ kind: 'message', attempt: this.cur, itemId: id, seq: this.seqOf(id), text, phase });
    return this;
  }
  work(id: string, itemType = 'command_execution'): this {
    const k = `${this.cur}:${id}`;
    if (this.sight.has(k)) return this;
    this.events.push({ kind: 'work', attempt: this.cur, itemId: id, seq: this.seqOf(id), itemType });
    return this;
  }
  end(terminal: 'completed' | 'no_terminal' = 'completed'): this {
    this.events.push({ kind: 'attempt_end', attempt: this.cur, terminal });
    return this;
  }
  select(mode: OutputSelectionMode = DEFAULT_OUTPUT_SELECTION_MODE, maxChars = BIG) {
    const c = new OutputCollector();
    for (const ev of this.events) c.push(ev);
    return c.select({ mode, maxChars });
  }
}

const s = () => new Script();

// Reference implementation of the baseline bridge + `collected.join('')`:
// messages of the attempt that ended normally, first-seen order, non-empty
// texts, '' join.
function baselineJoin(events: AgentOutputEvent[]): string {
  let out = '';
  let cur = new Map<string, string>();
  let order: string[] = [];
  for (const ev of events) {
    if (ev.kind === 'attempt_start') {
      cur = new Map();
      order = [];
    } else if (ev.kind === 'message') {
      if (!cur.has(ev.itemId)) order.push(ev.itemId);
      cur.set(ev.itemId, ev.text);
    } else if (ev.kind === 'attempt_end') {
      for (const id of order) out += cur.get(id) ?? '';
    }
  }
  return out;
}

// ─── Selection table ─────────────────────────────────────────────────────────

describe('selection table', () => {
  it('uses the shipped default unless a compatibility mode is explicit', () => {
    const script = s().start().msg('p', 'checking').msg('a', 'answer').end();
    expect(script.select().text).toBe('answer');
    expect(script.select('phase').text).toBe('checking\n\nanswer');
  });
  it('T1: commentary → work → final, heuristic keeps only the final', () => {
    const sel = s().start().msg('m0', 'Let me check.').work('w1').msg('m2', 'The answer is 42.').end().select('heuristic');
    expect(sel.text).toBe('The answer is 42.');
    expect(sel.source).toBe('trailing');
    expect(sel.droppedMessageCount).toBe(1);
    expect(sel.messageIds).toEqual(['m2']);
  });

  it('T1 (explicit compatibility phase mode on unlabeled messages): delivers all, delimited', () => {
    const sel = s().start().msg('m0', 'Let me check.').work('w1').msg('m2', 'The answer is 42.').end().select('phase');
    expect(sel.text).toBe('Let me check.\n\nThe answer is 42.');
    expect(sel.source).toBe('unclassified_all');
    expect(sel.droppedMessageCount).toBe(0);
  });

  it('T2: multiple snapshots of one item keep one entry, last text, first position', () => {
    const sel = s().start().msg('a', 'v1').msg('b', 'second').msg('a', 'v2').end().select('phase');
    expect(sel.text).toBe('v2\n\nsecond');
    expect(sel.messageIds).toEqual(['a', 'b']);
  });

  it('T3: multiple trailing messages after the last work item are all kept', () => {
    const sel = s().start().msg('c', 'thinking').work('w').msg('f1', 'Part one.').msg('f2', 'Part two.').end().select('heuristic');
    expect(sel.text).toBe('Part one.\n\nPart two.');
    expect(sel.source).toBe('trailing');
  });

  it('T4: nothing after the last work item → R3 (all, delimited)', () => {
    const sel = s().start().msg('a', 'one').work('w').end().select('heuristic');
    expect(sel.source).toBe('unclassified_all');
    expect(sel.text).toBe('one');
  });

  it('T5: no-terminal turn skips R2 → R3', () => {
    const sel = s().start().msg('a', 'one').work('w').msg('b', 'two').end('no_terminal').select('heuristic');
    expect(sel.source).toBe('unclassified_all');
    expect(sel.text).toBe('one\n\ntwo');
  });

  it('T5: no-terminal turn with a known final still uses R1', () => {
    const sel = s().start().msg('a', 'c', 'commentary').msg('b', 'final', 'final_answer').end('no_terminal').select('heuristic');
    expect(sel.source).toBe('phase');
    expect(sel.text).toBe('final');
  });

  it('T9: all messages phased with finals → R1, only finals in seq order', () => {
    const sel = s().start()
      .msg('a', 'c1', 'commentary').work('w').msg('b', 'f1', 'final_answer').msg('c', 'f2', 'final_answer')
      .end().select('phase');
    expect(sel.source).toBe('phase');
    expect(sel.text).toBe('f1\n\nf2');
    expect(sel.droppedMessageCount).toBe(1);
  });

  it('T16: fully phased, all commentary → R4 last resort', () => {
    const sel = s().start().msg('a', 'c1', 'commentary').work('w').msg('b', 'c2', 'commentary').end().select('heuristic');
    expect(sel.source).toBe('commentary_last_resort');
    expect(sel.text).toBe('c1\n\nc2');
  });

  it('T17: mixed commentary + unknown, no final → known commentary excluded, U selected', () => {
    const sel = s().start().msg('a', 'c1', 'commentary').msg('b', 'u1').end().select('phase');
    expect(sel.source).toBe('unclassified_all');
    expect(sel.text).toBe('u1');
  });

  it('T18: mixed with a known final → only known finals', () => {
    const sel = s().start().msg('a', 'u1').msg('b', 'c1', 'commentary').msg('c', 'f1', 'final_answer').end().select('heuristic');
    expect(sel.source).toBe('phase');
    expect(sel.text).toBe('f1');
  });

  it('T19: substantive guard — a long pre-work message trips R2 → R3', () => {
    const long = 'x'.repeat(401);
    const sel = s().start().msg('a', long).work('w').msg('b', 'Done.').end().select('heuristic');
    expect(sel.source).toBe('unclassified_all');
    expect(sel.text).toBe(`${long}\n\nDone.`);
  });

  it('T19: guard threshold is max(400, 2 × selected length), lengths only', () => {
    const trailing = 'y'.repeat(300);
    // 2 × 300 = 600 > 400: a 600-char dropped message does not trip, 601 does.
    const keep = s().start().msg('a', 'x'.repeat(600)).work('w').msg('b', trailing).end().select('heuristic');
    expect(keep.source).toBe('trailing');
    const trip = s().start().msg('a', 'x'.repeat(601)).work('w').msg('b', trailing).end().select('heuristic');
    expect(trip.source).toBe('unclassified_all');
  });

  it('T20: no-work commentary → final in heuristic mode delivers both (last work seq = -Infinity)', () => {
    const sel = s().start().msg('a', 'Let me look.').msg('b', 'The answer is X.').end().select('heuristic');
    expect(sel.source).toBe('trailing');
    expect(sel.text).toBe('Let me look.\n\nThe answer is X.');
  });

  it('T21: work started X → final → work completed X uses the first-sight boundary', () => {
    const sel = s().start().work('X').msg('m', 'final').work('X').end().select('heuristic');
    expect(sel.source).toBe('trailing');
    expect(sel.text).toBe('final');
  });

  it('R5: no messages → empty', () => {
    const sel = s().start().work('w').end().select('phase');
    expect(sel.source).toBe('empty');
    expect(sel.text).toBe('');
  });

  it('empty-text messages are ignored (baseline never yielded them)', () => {
    const sel = s().start().msg('a', '').msg('b', 'real').end().select('phase');
    expect(sel.text).toBe('real');
    expect(sel.messageIds).toEqual(['b']);
  });

  it('T15: artifacts slot stays empty (no outbound producer)', () => {
    const sel = s().start().msg('a', 'hi').end().select('phase');
    expect(sel.artifacts).toEqual([]);
  });

  it('describeSelection logs counts only, never message text', () => {
    const sel = s().start().msg('a', 'SECRET TEXT').end().select('phase');
    const line = describeSelection(sel, 'phase', 1);
    expect(line).toBe('[output-selection] mode=phase source=unclassified_all pool=primary kept=1 dropped=0 chars=11 truncated=false attempts=1');
    expect(line).not.toContain('SECRET');
  });
});

// ─── Attempt eligibility ─────────────────────────────────────────────────────

describe('attempt eligibility', () => {
  it('T7a: I → R(I) with R producing messages → only R', () => {
    const sel = s().start().msg('item_0', 'from I')
      .start('request_retry', 0).msg('item_0', 'from R').end().select('phase');
    expect(sel.text).toBe('from R');
    expect(sel.pool).toBe('primary');
    expect(sel.droppedMessageCount).toBe(1);
  });

  it('T7b: R empty, I has an unknown message → lineage', () => {
    const sel = s().start().msg('item_0', 'u1').work('item_1')
      .start('request_retry', 0).end().select('phase');
    expect(sel.text).toBe('u1');
    expect(sel.pool).toBe('lineage');
    expect(sel.source).toBe('unclassified_all');
  });

  it('T7c: I(stale) → FR with FR empty → empty (stale attempt never eligible)', () => {
    const sel = s().start().msg('item_0', 'stale')
      .start('request_retry', null).end().select('phase');
    expect(sel.source).toBe('empty');
    expect(sel.text).toBe('');
  });

  it('T7d: I(stale) → FR → R(FR) with R empty → lineage is FR only', () => {
    const sel = s().start().msg('item_0', 'stale')
      .start('request_retry', null).msg('item_0', 'fresh')
      .start('request_retry', 1).end().select('phase');
    expect(sel.text).toBe('fresh');
    expect(sel.pool).toBe('lineage');
  });

  it('T7e: I commentary → R(I) commentary only → only R commentary (lineage unused)', () => {
    const sel = s().start().msg('item_0', 'c1', 'commentary')
      .start('request_retry', 0).msg('item_0', 'c2', 'commentary').end().select('phase');
    expect(sel.text).toBe('c2');
    expect(sel.source).toBe('commentary_last_resort');
    expect(sel.pool).toBe('primary');
  });

  it('T7f: R empty, I commentary only → K_comm(L)', () => {
    const sel = s().start().msg('item_0', 'c1', 'commentary')
      .start('request_retry', 0).end().select('phase');
    expect(sel.text).toBe('c1');
    expect(sel.source).toBe('commentary_last_resort');
    expect(sel.pool).toBe('lineage');
  });

  it('T8: a stale attempt never contributes, even with messages and a non-empty FR', () => {
    const sel = s().start().msg('item_0', 'stale')
      .start('request_retry', null).msg('item_0', 'fresh').end().select('phase');
    expect(sel.text).toBe('fresh');
    expect(sel.droppedMessageCount).toBe(0);
  });

  it('heuristic R2 is not applied to the lineage pool', () => {
    const sel = s().start().msg('item_0', 'a').work('item_1').msg('item_2', 'b')
      .start('request_retry', 0).end().select('heuristic');
    expect(sel.source).toBe('unclassified_all');
    expect(sel.text).toBe('a\n\nb');
  });
});

// ─── Legacy compatibility ────────────────────────────────────────────────────

describe('T14: legacy mode equals the baseline join', () => {
  const chains: Array<[string, Script]> = [
    ['I', s().start().msg('a', 'one').work('w').msg('b', 'two').end()],
    ['I → R(I)', s().start().msg('a', 'lost').start('request_retry', 0).msg('a', 'kept').msg('b', '!').end()],
    ['I(stale) → FR', s().start().msg('a', 'stale').start('request_retry', null).msg('a', 'fresh').end()],
    ['I(stale) → FR → R(FR)', s().start().start('request_retry', null).msg('a', 'x').start('request_retry', 1).msg('a', 'y').end()],
    ['snapshots', s().start().msg('a', 'v1').msg('b', 'B').msg('a', 'v2').end()],
    ['phased', s().start().msg('a', 'c', 'commentary').msg('b', 'f', 'final_answer').end()],
    ['empty texts', s().start().msg('a', '').msg('b', 'B').end()],
    ['R empty (no lineage in legacy)', s().start().msg('a', 'I').start('request_retry', 0).end()],
  ];
  for (const [name, script] of chains) {
    it(name, () => {
      const sel = script.select('legacy');
      expect(sel.text).toBe(baselineJoin(script.events));
    });
  }

  it('legacy uses no separator and keeps commentary', () => {
    const sel = s().start().msg('a', 'c', 'commentary').msg('b', 'f', 'final_answer').end().select('legacy');
    expect(sel.text).toBe('cf');
    expect(sel.source).toBe('legacy_all');
  });
});

// ─── Cap ─────────────────────────────────────────────────────────────────────

describe('cap rule', () => {
  const max = 1024;
  const SUF = TRUNCATION_SUFFIX;

  it('suffix is the 22-char notice shared with the relay', () => {
    expect(SUF).toBe('\n\n[response truncated]');
    expect(SUF.length).toBe(22);
  });

  it('B1: length max−1 and max are unchanged', () => {
    for (const n of [max - 1, max]) {
      const r = capSelected('a'.repeat(n), max);
      expect(r.truncated).toBe(false);
      expect(r.text.length).toBe(n);
    }
  });

  it('B2: length max+1 → exactly max chars ending with the suffix', () => {
    const r = capSelected('a'.repeat(max + 1), max);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(max);
    expect(r.text.endsWith(SUF)).toBe(true);
  });

  it('B3: high surrogate at body boundary−1 backs off one unit (no orphan)', () => {
    const body = 'a'.repeat(max - 23) + '😀' + 'b'.repeat(200);
    const r = capSelected(body, max);
    expect(r.text.length).toBe(max - 1);
    expect(r.text).toBe('a'.repeat(max - 23) + SUF);
  });

  it('B4: high surrogate at max−1 → no stray newline, length ≤ max', () => {
    const body = 'a'.repeat(max - 1) + '😀' + 'b'.repeat(10);
    const r = capSelected(body, max);
    expect(r.text.length).toBe(max);
    expect(r.text).toBe('a'.repeat(max - 22) + SUF);
  });

  it('B7b: small-limit mode (1–44) truncates without the suffix', () => {
    for (const m of [10, 44]) {
      const r = capSelected('z'.repeat(100), m);
      expect(r.text).toBe('z'.repeat(m));
      expect(isSmallResponseLimit(m)).toBe(true);
    }
  });

  it('B7d: max = 45 uses headroom mode; max = 1 with an astral char yields …', () => {
    expect(isSmallResponseLimit(45)).toBe(false);
    const r45 = capSelected('q'.repeat(100), 45);
    expect(r45.text).toBe('q'.repeat(23) + SUF);
    expect(r45.text.length).toBe(45);
    expect(capSelected('😀abc', 1)).toEqual({ text: '…', truncated: true });
    expect(capSelected('abc', 1)).toEqual({ text: 'a', truncated: true });
  });

  it('cap applies to the selected join in every mode', () => {
    for (const mode of ['phase', 'heuristic', 'legacy'] as const) {
      const sel = s().start().msg('a', 'x'.repeat(80)).msg('b', 'y'.repeat(80)).end().select(mode, 100);
      expect(sel.truncated).toBe(true);
      expect(sel.text.length).toBeLessThanOrEqual(100);
      expect(sel.text.endsWith(SUF)).toBe(true);
    }
  });

  it('B6: output never exceeds max and never ends in an orphan high surrogate', () => {
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = ['a', ' ', '\n', '😀', '中', '@'];
    for (let i = 0; i < 200; i++) {
      const m = 1 + Math.floor(rnd() * 120);
      let str = '';
      const len = Math.floor(rnd() * 200);
      for (let j = 0; j < len; j++) str += alphabet[Math.floor(rnd() * alphabet.length)];
      const r = capSelected(str, m);
      expect(r.text.length).toBeLessThanOrEqual(m);
      const body = r.text.endsWith(SUF) ? r.text.slice(0, -SUF.length) : r.text;
      const last = body.charCodeAt(body.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      if (str.length <= m) expect(r.text).toBe(str);
    }
  });
});
