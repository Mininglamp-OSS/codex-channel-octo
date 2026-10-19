/** Default reply selection with the phase-free exec JSONL transport. */
import { describe, it, expect } from 'vitest';
import {
  OutputCollector,
  DEFAULT_OUTPUT_SELECTION_MODE,
  describeSelection,
  type OutputSelectionMode,
} from '../output-selection.js';
import type { AgentOutputEvent, MessagePhase } from '../agent-bridge.js';

const start = (attempt = 0, continues: number | null = null): AgentOutputEvent => ({
  kind: 'attempt_start', attempt, reason: continues === null ? 'initial' : 'stream_recovery', continues,
});
const message = (id: string, text: string, seq: number, phase: MessagePhase = 'unknown', attempt = 0): AgentOutputEvent => ({
  kind: 'message', attempt, itemId: id, text, seq, phase,
});
const end = (attempt = 0, terminal: 'completed' | 'no_terminal' = 'completed'): AgentOutputEvent => ({
  kind: 'attempt_end', attempt, terminal,
});
const work: AgentOutputEvent = { kind: 'work', attempt: 0, itemId: 'w', seq: 1, itemType: 'command_execution' };
function select(events: AgentOutputEvent[], mode: OutputSelectionMode = DEFAULT_OUTPUT_SELECTION_MODE, maxChars = 524288) {
  const collector = new OutputCollector();
  for (const event of events) collector.push(event);
  return collector.select({ mode, maxChars });
}

describe('default final selection without SDK phase metadata', () => {
  it('uses a deterministic last-message fallback, not all unlabeled narration', () => {
    const result = select([start(), message('p', 'checking', 0), message('f', 'answer', 1), end()]);
    expect(DEFAULT_OUTPUT_SELECTION_MODE).toBe('final');
    expect(result).toMatchObject({ text: 'answer', source: 'last_message', droppedMessageCount: 1 });
    expect(describeSelection(result, 'final', 1)).toContain('source=last_message');
  });
  it('does not concatenate several short unlabeled messages after work', () => {
    expect(select([start(), work, message('p', 'checking result', 2), message('f', 'answer', 3), end()]).text).toBe('answer');
  });
  it('replaces snapshots without making an earlier item the final item', () => {
    const result = select([start(), message('a', 'old', 0), message('b', 'answer', 1), message('a', 'updated', 0), end()]);
    expect(result.text).toBe('answer');
    expect(result.messageIds).toEqual(['b']);
  });
  it('keeps the latest snapshot of the selected item', () => {
    expect(select([start(), message('f', 'old', 0), message('f', 'answer', 0), end()]).text).toBe('answer');
  });
  it.each([' \n', '\t', '\u200b', '\u2060', '\ufeff', '\u200d\u200c'])('ignores formatting-only trailing messages (%j)', blank => {
    const result = select([start(), message('a', 'answer', 0), message('b', blank, 1), message('f', blank, 2, 'final_answer'), end()]);
    expect(result).toMatchObject({ text: 'answer', droppedMessageCount: 0 });
  });
  it('preserves joiners inside otherwise visible text', () => {
    expect(select([start(), message('a', '👩\u200d💻', 0), end()]).text).toBe('👩\u200d💻');
  });
  it('preserves every explicit final part and excludes commentary/partial text', () => {
    const result = select([start(), message('c', 'progress', 0, 'commentary'), message('p', 'draft', 1, 'partial_answer'),
      message('f1', 'part one', 2, 'final_answer'), message('f2', 'part two', 3, 'final_answer'), end()]);
    expect(result.text).toBe('part one\n\npart two');
  });
  it.each(['completed', 'no_terminal'] as const)('labels commentary-only fallback (%s)', terminal => {
    const result = select([start(), message('a', 'first', 0, 'commentary'), message('b', 'last', 1, 'commentary'), end(0, terminal)]);
    expect(result).toMatchObject({ text: 'last', source: terminal === 'completed' ? 'commentary_last' : 'commentary_last_partial' });
  });
  it.each([' \n', '\u200b'])('does not newly expose commentary beside blank unknown output (%j)', blank => {
    expect(select([start(), message('a', blank, 0), message('c', 'INTERNAL progress', 1, 'commentary'), end()]).text).toBe('');
  });
  it('does not append commentary emitted after an unknown answer', () => {
    expect(select([start(), message('a', 'answer', 0), message('b', 'progress', 1, 'commentary'), end()]).text).toBe('answer');
  });
  it.each([false, true])('keeps only the short tail regardless of earlier answer length (work=%s)', withWork => {
    const result = select([start(), message('a', 'answer'.repeat(850), 0), ...(withWork ? [work] : []), message('b', 'All done.', 2), end()]);
    expect(result).toMatchObject({ text: 'All done.', source: 'last_message', messageIds: ['b'], droppedMessageCount: 1 });
  });
  it.each([400, 401, 10000])('never restores long unlabeled progress (%s characters)', length => {
    const result = select([start(), message('p', 'p'.repeat(length), 0), work, message('a', '42', 2), end()]);
    expect(result).toMatchObject({ text: '42', source: 'last_message', messageIds: ['a'], droppedMessageCount: 1 });
  });
  it('drops all five progress messages before a short final response', () => {
    const progress = Array.from({ length: 5 }, (_, i) => message(`p${i}`, 'progress '.repeat(500), i));
    expect(select([start(), ...progress, message('a', 'done', 5), end()]))
      .toMatchObject({ text: 'done', messageIds: ['a'], droppedMessageCount: 5 });
  });
  it('caps only the selected partial tail and preserves partial diagnostics', () => {
    const result = select([start(), message('a', 'a'.repeat(1000), 0), message('b', 'answer'.repeat(20), 1, 'partial_answer'), end()], 'final', 50);
    expect(result).toMatchObject({ source: 'last_message_partial', truncated: true, messageIds: ['b'] });
    expect(result.text).toHaveLength(50);
    expect(result.text).not.toContain('aaaa');
  });
  it('marks explicit partial content and no-terminal fallbacks as partial', () => {
    expect(select([start(), message('a', 'partial', 0, 'partial_answer'), end()]).source).toBe('last_message_partial');
    expect(select([start(), message('a', 'partial', 0), end(0, 'no_terminal')]).source).toBe('last_message_partial');
  });
  it.each(['', ' \n', '\u2060'])('inherits useful recovery output after a formatting-only result (%j)', blank => {
    expect(select([start(), message('a', 'progress', 0), message('b', 'partial', 1), start(1, 0), message('blank', blank, 2, 'unknown', 1), end(1)]))
      .toMatchObject({ text: 'partial', pool: 'lineage', source: 'last_message_partial' });
  });
  it('does not count lineage as dropped when primary output is used', () => {
    expect(select([start(), message('a', 'old', 0), start(1, 0), message('b', 'new', 1, 'unknown', 1), end(1)]))
      .toMatchObject({ text: 'new', pool: 'primary', droppedMessageCount: 0 });
  });
  it('reports primary when blank output has no eligible ancestors', () => {
    expect(select([start(), message('a', ' \n', 0), end()])).toMatchObject({ text: '', pool: 'primary', droppedMessageCount: 0 });
    expect(select([start(), message('a', 'old', 0), start(1), end(1)]).text).toBe('');
  });
  it('caps only the selected fallback and does not expose excluded text', () => {
    const result = select([start(), message('p', 'PRIVATE PROGRESS', 0), message('f', 'answer'.repeat(30), 1), end()], 'final', 50);
    expect(result.text).toHaveLength(50);
    expect(result.text).not.toContain('PRIVATE');
  });
  it.each(['final', 'phase', 'heuristic', 'legacy'] as const)('ignores an unfinished message lacking text (%s)', mode => {
    const missing = { kind: 'message', attempt: 0, itemId: 'unfinished', seq: 1, phase: 'unknown' } as AgentOutputEvent;
    expect(select([start(), message('a', 'answer', 0), missing, end()], mode).text).toBe('answer');
  });
  it('retains explicit phase and legacy compatibility modes', () => {
    const events = [start(), message('a', 'one', 0), message('b', 'two', 1), end()];
    expect(select(events, 'phase').text).toBe('one\n\ntwo');
    expect(select(events, 'legacy').text).toBe('onetwo');
  });
});
